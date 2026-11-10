// Setup API (docs/GOAL.md item 5): status, API keys, printers, slicer, feature toggles, finish.
// Mounted by apps/server next to auth.routes. Every input is validated; secrets are written to the
// secret store and only ever reported back as set / not set.
import { randomBytes } from "node:crypto";
import { PRINTERS, type PrinterModel } from "@morphix/catalog";
import { getDriver as registryDriver, DRIVERS, type ConnectionField, type Discovered, type DriverConfig, type DriverDeps, type DriverId, type PrinterDriver, type TestResult } from "@morphix/printer";
import type { SlicerAdapter, SlicerId } from "@morphix/slicing";
import { guarded, jsonBody } from "./auth";
import { API_KEYS, testApiKey, type ApiKeyName } from "./keys";
import { SLICER_IDS, type StoreIssue } from "./store";
import { SECRET_KEYS, type Access, type AuthProvider, type ConfigStore, type ConfiguredPrinter, type MorphixConfig, type RouteHandler, type RouteModule, type SecretKey } from "./types";
import { InputError, checkApiKey, checkExecPath, checkHost, checkPort, checkSerialPort, checkText, isRecord, must } from "./validate";

export const DOCS_BASE = "https://github.com/JI-s-BS/morphix/blob/main/";

export const SLICER_NAMES: Record<SlicerId, string> = { prusaslicer: "PrusaSlicer", orcaslicer: "OrcaSlicer", bambustudio: "Bambu Studio" };

/** Which keys a feature can use (any one of them is enough). */
export const FEATURE_KEYS: Record<keyof MorphixConfig["features"], ApiKeyName[]> = {
  voice: ["GEMINI_API_KEY"],
  aiGeneration: ["MESHY_API_KEY", "ANTHROPIC_API_KEY"],
  modelSearch: ["THINGIVERSE_TOKEN", "GEMINI_API_KEY"],
  guardian: ["GEMINI_API_KEY"],
};
const FEATURE_LABELS: Record<keyof MorphixConfig["features"], string> = {
  voice: "Voice assistant", aiGeneration: "AI model generation", modelSearch: "Model search", guardian: "Print Guardian",
};

export interface SlicerChoice {
  id: SlicerId;
  name: string;
  /** null = not checked (no adapter available to detect it). */
  installed: boolean | null;
  version?: string | null;
  path?: string;
  /** How to install it, when it isn't. */
  hint?: string;
  /** Whether it can slice for the active printer (undefined when unknown). */
  supportsActivePrinter?: boolean;
}

export interface SetupDeps {
  store: ConfigStore;
  /** Used to re-check "setup" access and report whether setup is open. */
  auth: AuthProvider;
  /** Defaults to the @morphix/catalog list. */
  catalog?: readonly PrinterModel[];
  /** Defaults to the @morphix/printer registry. */
  drivers?: readonly PrinterDriver[];
  /** Slicer adapters (packages/slicing/src/adapters) used to detect installs. Without them the plain SlicerId list is offered. */
  slicerAdapters?: readonly SlicerAdapter[];
  /** For key tests and drivers (tests inject a fake). */
  fetch?: typeof fetch;
  driverDeps?: DriverDeps;
  /** Store problems to show on the setup page (FileConfigStore.issues). */
  issues?: () => StoreIssue[];
  /** Timeouts (ms). */
  printerTestTimeoutMs?: number;
  discoverTimeoutMs?: number;
  keyTestTimeoutMs?: number;
}

const newId = () => randomBytes(6).toString("hex");
const FIELD_KEY = /^[A-Za-z0-9_-]{1,40}$/;
const secretName = (printerId: string, key: string) => `printer:${printerId}:${key}` as SecretKey;
const isApiKey = (k: string): k is ApiKeyName => (SECRET_KEYS as readonly string[]).includes(k);

export function setupRoutes(deps: SetupDeps): RouteModule {
  const { store, auth } = deps;
  const catalog = () => deps.catalog ?? PRINTERS;
  const drivers = () => deps.drivers ?? DRIVERS;
  const driverFor = (id: string) => (deps.drivers ? deps.drivers.find((d) => d.id === id) : registryDriver(id));

  return (router) => {
    const add = (method: "GET" | "POST" | "PUT" | "DELETE", pattern: string, access: Access, h: RouteHandler) =>
      router.add(method, pattern, access, guarded(access, auth.setupOpen, h));
    const noStore = { "Cache-Control": "no-store" };

    // ---------------------------------------------------------------- status ---
    add("GET", "/api/setup/status", "public", async (ctx) => {
      const config = await store.load();
      const base = { setupOpen: await auth.setupOpen(), setupComplete: config.setupComplete };
      if (ctx.user?.role !== "admin") return ctx.send(200, base, noStore);
      const secrets = await store.secretStatus();
      const keys = Object.fromEntries(SECRET_KEYS.map((k) => [k, Boolean(secrets[k])]));
      ctx.send(200, {
        ...base,
        steps: { admin: !base.setupOpen, printer: config.printers.length > 0, slicer: Boolean(config.slicer.preferred), keys: Object.values(keys).some(Boolean) },
        printers: config.printers.length,
        activePrinterId: config.activePrinterId ?? null,
        slicer: config.slicer.preferred ?? null,
        keys,
        features: config.features,
        issues: (deps.issues?.() ?? []).map((i) => i.message),
      }, noStore);
    });

    // ---------------------------------------------------------------- catalog ---
    add("GET", "/api/setup/catalog", "admin", (ctx) => {
      const brands = new Map<string, ReturnType<typeof modelView>[]>();
      for (const m of catalog()) brands.set(m.brand, [...(brands.get(m.brand) ?? []), modelView(m)]);
      ctx.send(200, {
        brands: [...brands.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([brand, models]) => ({ brand, models })),
        drivers: drivers().map((d) => ({ id: d.id, name: d.name, description: d.description, fields: d.fields, canDiscover: typeof d.discover === "function" })),
      });
    });

    // ---------------------------------------------------------------- printers ---
    add("GET", "/api/setup/printers", "admin", async (ctx) => {
      const config = await store.load();
      ctx.send(200, { printers: await Promise.all(config.printers.map((p) => printerView(p))), activePrinterId: config.activePrinterId ?? null }, noStore);
    });

    add("POST", "/api/setup/printers", "admin", async (ctx) => {
      const input = await parsePrinter(await jsonBody(ctx));
      const config = await store.load();
      if (config.printers.length >= 20) throw new InputError("Too many printers (20 max).");
      const printer: ConfiguredPrinter = { id: newId(), name: input.name, modelId: input.model.id, driver: input.driver.id, connection: input.connection };
      await writeSecrets(printer.id, input.secrets);
      config.printers.push(printer);
      config.activePrinterId ??= printer.id;
      await store.save(config);
      ctx.send(201, { printer: await printerView(printer) });
    });

    add("PUT", "/api/setup/printers/:id", "admin", async (ctx) => {
      const config = await store.load();
      const cur = config.printers.find((p) => p.id === ctx.params.id);
      if (!cur) return ctx.send(404, { error: "No such printer." });
      const input = await parsePrinter(await jsonBody(ctx), cur);
      // Fields the new driver doesn't have any more: drop their secrets.
      const keep = new Set(input.driver.fields.filter((f) => f.kind === "secret").map((f) => f.key));
      const old = Object.keys(await store.secretStatus()).filter((k) => k.startsWith(`printer:${cur.id}:`));
      for (const k of old) if (!keep.has(k.split(":")[2])) await store.setSecret(k as SecretKey, null);
      await writeSecrets(cur.id, input.secrets);
      Object.assign(cur, { name: input.name, modelId: input.model.id, driver: input.driver.id, connection: input.connection });
      await store.save(config);
      ctx.send(200, { printer: await printerView(cur) });
    });

    add("DELETE", "/api/setup/printers/:id", "admin", async (ctx) => {
      const config = await store.load();
      const cur = config.printers.find((p) => p.id === ctx.params.id);
      if (!cur) return ctx.send(404, { error: "No such printer." });
      config.printers = config.printers.filter((p) => p !== cur);
      if (config.activePrinterId === cur.id) config.activePrinterId = config.printers[0]?.id;
      await store.save(config);
      for (const k of Object.keys(await store.secretStatus())) if (k.startsWith(`printer:${cur.id}:`)) await store.setSecret(k as SecretKey, null);
      ctx.send(200, { ok: true });
    });

    add("PUT", "/api/setup/active-printer", "admin", async (ctx) => {
      const b = await jsonBody(ctx);
      const config = await store.load();
      if (typeof b.id !== "string" || !config.printers.some((p) => p.id === b.id)) throw new InputError("Pick one of the saved printers.", "id");
      config.activePrinterId = b.id;
      await store.save(config);
      ctx.send(200, { activePrinterId: b.id });
    });

    /** Test a saved printer (optionally with edited, unsaved values in the body). */
    add("POST", "/api/setup/printers/:id/test", "admin", async (ctx) => {
      const config = await store.load();
      const cur = config.printers.find((p) => p.id === ctx.params.id);
      if (!cur) return ctx.send(404, { error: "No such printer." });
      const body = await optionalBody(ctx);
      const input = await parsePrinter(body ? { name: cur.name, modelId: cur.modelId, driver: cur.driver, ...body, connection: { ...cur.connection, ...(isRecord(body.connection) ? body.connection : {}) } } : { ...cur }, cur);
      const secrets: Record<string, string> = {};
      for (const f of input.driver.fields.filter((x) => x.kind === "secret")) {
        const v = input.secrets[f.key];
        if (typeof v === "string") secrets[f.key] = v;
        else if (v === undefined) {
          const s = await store.getSecret(secretName(cur.id, f.key));
          if (s) secrets[f.key] = s;
        }
      }
      ctx.send(200, { result: await runTest(input.driver, { ...input.connection, ...secrets }) }, noStore);
    });

    /** Test values before saving them (wizard: fill in → Test → Save). */
    add("POST", "/api/setup/test-printer", "admin", async (ctx) => {
      const input = await parsePrinter(await jsonBody(ctx), undefined, { requireSecrets: false, defaultName: true });
      const secrets = Object.fromEntries(Object.entries(input.secrets).filter((e): e is [string, string] => typeof e[1] === "string"));
      ctx.send(200, { result: await runTest(input.driver, { ...input.connection, ...secrets }) }, noStore);
    });

    add("POST", "/api/setup/discover", "admin", async (ctx) => {
      const b = (await optionalBody(ctx)) ?? {};
      if (b.driver !== undefined && (typeof b.driver !== "string" || !driverFor(b.driver))) throw new InputError("Unknown printer type.", "driver");
      const timeout = Math.min(10_000, Math.max(1000, typeof b.timeoutMs === "number" ? b.timeoutMs : deps.discoverTimeoutMs ?? 4000));
      const list = drivers().filter((d) => d.discover && (b.driver === undefined || d.id === b.driver));
      const settled = await Promise.allSettled(list.map((d) => withTimeout(d.discover!(timeout), timeout + 1000, [] as Discovered[])));
      const seen = new Set<string>();
      const found: (Discovered & { models: string[] })[] = [];
      for (const r of settled) {
        if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
        for (const d of r.value.slice(0, 50)) {
          if (!d || typeof d.host !== "string" || checkHost(d.host)) continue;
          const k = `${d.driver}|${d.host}|${d.port ?? ""}`;
          if (seen.has(k)) continue;
          seen.add(k);
          found.push({ ...pick(d), models: catalog().filter((m) => m.driver === d.driver || m.altDrivers?.includes(d.driver)).map((m) => m.id) });
        }
      }
      ctx.send(200, { found, searched: list.map((d) => d.id) }, noStore);
    });

    // ---------------------------------------------------------------- slicer ---
    add("GET", "/api/setup/slicers", "admin", async (ctx) => {
      const config = await store.load();
      ctx.send(200, { slicers: await slicerChoices(config), preferred: config.slicer.preferred ?? null, paths: config.slicer.paths ?? {} }, noStore);
    });

    add("PUT", "/api/setup/slicer", "admin", async (ctx) => {
      const b = await jsonBody(ctx);
      const config = await store.load();
      if (b.preferred !== null && !SLICER_IDS.includes(b.preferred as SlicerId)) throw new InputError("Pick PrusaSlicer, OrcaSlicer or Bambu Studio.", "preferred");
      if (b.preferred === null) delete config.slicer.preferred;
      else config.slicer.preferred = b.preferred as SlicerId;
      if (b.paths !== undefined) {
        if (!isRecord(b.paths)) throw new InputError("paths must be an object.", "paths");
        const paths: Partial<Record<SlicerId, string>> = {};
        for (const [k, v] of Object.entries(b.paths)) {
          if (!SLICER_IDS.includes(k as SlicerId)) throw new InputError("Unknown slicer.", "paths");
          if (v === null || v === "") continue;
          must(checkExecPath(v, `${SLICER_NAMES[k as SlicerId]} path`), "paths");
          paths[k as SlicerId] = v as string;
        }
        config.slicer.paths = paths;
      }
      await store.save(config);
      ctx.send(200, { preferred: config.slicer.preferred ?? null, paths: config.slicer.paths ?? {} });
    });

    // ---------------------------------------------------------------- API keys ---
    add("GET", "/api/setup/keys", "admin", async (ctx) => {
      const s = await store.secretStatus();
      ctx.send(200, { keys: API_KEYS.map((k) => ({ ...k, set: Boolean(s[k.key]) })) }, noStore);
    });

    add("PUT", "/api/setup/keys/:key", "admin", async (ctx) => {
      const name = ctx.params.key;
      if (!isApiKey(name)) return ctx.send(404, { error: "Unknown key." });
      const b = await jsonBody(ctx);
      must(checkApiKey(b.value), "value");
      await store.setSecret(name, (b.value as string).trim());
      // During first setup, a new key switches on the features it unlocks.
      const config = await store.load();
      if (!config.setupComplete) {
        for (const [f, keys] of Object.entries(FEATURE_KEYS) as [keyof MorphixConfig["features"], ApiKeyName[]][]) if (keys.includes(name)) config.features[f] = true;
        await store.save(config);
      }
      ctx.send(200, { key: name, set: true, features: config.features });
    });

    add("DELETE", "/api/setup/keys/:key", "admin", async (ctx) => {
      const name = ctx.params.key;
      if (!isApiKey(name)) return ctx.send(404, { error: "Unknown key." });
      await store.setSecret(name, null);
      // Features left without any key are switched off.
      const s = await store.secretStatus();
      const config = await store.load();
      for (const [f, keys] of Object.entries(FEATURE_KEYS) as [keyof MorphixConfig["features"], ApiKeyName[]][]) if (!keys.some((k) => s[k])) config.features[f] = false;
      await store.save(config);
      ctx.send(200, { key: name, set: false, features: config.features });
    });

    /** Body { value } tests a key before saving; no body tests the saved one. */
    add("POST", "/api/setup/keys/:key/test", "admin", async (ctx) => {
      const name = ctx.params.key;
      if (!isApiKey(name)) return ctx.send(404, { error: "Unknown key." });
      const b = await optionalBody(ctx);
      let value: string | undefined;
      if (b && b.value !== undefined && b.value !== "") {
        must(checkApiKey(b.value), "value");
        value = (b.value as string).trim();
      } else value = await store.getSecret(name);
      if (!value) return ctx.send(200, { result: { ok: false, message: "No key saved yet.", hint: "Paste the key, then test it." } }, noStore);
      const result = await testApiKey(name, value, { fetch: deps.fetch, timeoutMs: deps.keyTestTimeoutMs });
      ctx.send(200, { result: { ...result, message: scrub(result.message, [value]), ...("hint" in result && result.hint ? { hint: scrub(result.hint, [value]) } : {}) } }, noStore);
    });

    // ---------------------------------------------------------------- features / finish ---
    add("PUT", "/api/setup/features", "admin", async (ctx) => {
      const b = await jsonBody(ctx);
      const config = await store.load();
      const s = await store.secretStatus();
      for (const [k, v] of Object.entries(b)) {
        if (!(k in config.features)) throw new InputError(`Unknown feature ${k.slice(0, 30)}.`, k.slice(0, 30));
        if (typeof v !== "boolean") throw new InputError(`${FEATURE_LABELS[k as keyof MorphixConfig["features"]]} must be on or off.`, k);
        const needs = FEATURE_KEYS[k as keyof MorphixConfig["features"]];
        if (v && !needs.some((n) => s[n])) {
          const labels = needs.map((n) => API_KEYS.find((x) => x.key === n)!.label).join(" or ");
          throw new InputError(`${FEATURE_LABELS[k as keyof MorphixConfig["features"]]} needs the ${labels} key. Add it under API keys first.`, k);
        }
        config.features[k as keyof MorphixConfig["features"]] = v;
      }
      await store.save(config);
      ctx.send(200, { features: config.features });
    });

    add("POST", "/api/setup/finish", "admin", async (ctx) => {
      const config = await store.load();
      config.setupComplete = true;
      await store.save(config);
      ctx.send(200, { setupComplete: true });
    });
  };

  // ------------------------------------------------------------------ helpers ---
  function modelView(m: PrinterModel) {
    const doc = /^docs\/[A-Za-z0-9/_.-]+\.md$/.test(m.setupDoc) && !m.setupDoc.includes("..") ? m.setupDoc : undefined;
    return {
      id: m.id, brand: m.brand, model: m.model, driver: m.driver, altDrivers: m.altDrivers ?? [], verified: m.verified,
      setupDoc: doc, docUrl: doc ? DOCS_BASE + doc : undefined,
      driverAvailable: Boolean(driverFor(m.driver)),
      bed: m.bed, fileFormat: m.fileFormat,
    };
  }

  async function printerView(p: ConfiguredPrinter) {
    const d = driverFor(p.driver);
    const s = await store.secretStatus();
    const secretFields: Record<string, boolean> = {};
    for (const f of d?.fields.filter((x) => x.kind === "secret") ?? []) secretFields[f.key] = Boolean(s[secretName(p.id, f.key)]);
    return { ...p, connection: { ...p.connection }, secretFields, driverName: d?.name ?? p.driver, driverAvailable: Boolean(d) };
  }

  async function writeSecrets(printerId: string, secrets: Record<string, string | null | undefined>) {
    for (const [k, v] of Object.entries(secrets)) if (v !== undefined) await store.setSecret(secretName(printerId, k), v);
  }

  /**
   * Body { name, modelId, driver?, connection } → checked values. Secret fields: a string sets it,
   * null clears it, missing / "" keeps the saved one (when editing).
   */
  async function parsePrinter(b: Record<string, unknown>, existing?: ConfiguredPrinter, opts: { requireSecrets?: boolean; defaultName?: boolean } = {}) {
    if (typeof b.modelId !== "string") throw new InputError("Pick your printer model.", "modelId");
    const model = catalog().find((m) => m.id === b.modelId);
    if (!model) throw new InputError("That printer model isn't in the list.", "modelId");
    const driverId = b.driver === undefined || b.driver === null || b.driver === "" ? model.driver : b.driver;
    if (typeof driverId !== "string" || (driverId !== model.driver && !model.altDrivers?.includes(driverId as DriverId))) throw new InputError("That connection type doesn't work with this model.", "driver");
    const driver = driverFor(driverId);
    if (!driver) throw new InputError(`This version of Morphix can't talk to the ${model.brand} ${model.model} yet (no ${driverId} driver).`, "driver");

    const name = b.name === undefined && (opts.defaultName || existing) ? existing?.name ?? `${model.brand} ${model.model}` : b.name;
    must(checkText(name, "Printer name", { min: 1, max: 60 }), "name");

    const raw = b.connection === undefined ? {} : b.connection;
    if (!isRecord(raw)) throw new InputError("Connection settings must be an object.", "connection");
    const connection: ConfiguredPrinter["connection"] = {};
    const secrets: Record<string, string | null | undefined> = {};
    for (const f of driver.fields) {
      if (!FIELD_KEY.test(f.key)) continue;
      const v = raw[f.key];
      if (f.kind === "secret") {
        if (v === null) {
          if (f.required && opts.requireSecrets !== false) throw new InputError(`${f.label} is required.`, f.key);
          secrets[f.key] = null;
        } else if (v === undefined || v === "") {
          const saved = existing ? await store.getSecret(secretName(existing.id, f.key)) : undefined;
          if (f.required && !saved && opts.requireSecrets !== false) throw new InputError(`${f.label} is required.`, f.key);
        } else {
          must(checkText(v, f.label, { min: 1, max: 512 }), f.key);
          secrets[f.key] = v as string;
        }
        continue;
      }
      const val = fieldValue(f, v);
      if (val !== undefined) connection[f.key] = val;
    }
    return { name: (name as string).trim(), model, driver, connection, secrets };
  }

  async function runTest(driver: PrinterDriver, config: DriverConfig): Promise<TestResult> {
    const secretValues = driver.fields.filter((f) => f.kind === "secret").map((f) => config[f.key]).filter((v): v is string => typeof v === "string" && v.length > 0);
    const ms = deps.printerTestTimeoutMs ?? 15_000;
    let conn: ReturnType<PrinterDriver["connect"]> | undefined;
    let result: TestResult;
    try {
      conn = driver.connect(config, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...deps.driverDeps });
      result = await withTimeout(conn.test(), ms, {
        ok: false, code: "timeout", message: `The printer didn't answer within ${Math.round(ms / 1000)} seconds.`,
        hint: "Check that it's switched on, on the same network as this machine, and that the address is right.",
      } as TestResult);
    } catch (e) {
      result = { ok: false, code: "protocol", message: (e as Error)?.message || "The connection test failed.", hint: "Check the connection settings and try again." };
    } finally {
      void Promise.resolve().then(() => conn?.close()).catch(() => undefined);
    }
    // Never let a driver bug put a password / access code into the browser.
    if (result.ok) {
      const info = Object.fromEntries(Object.entries(result.info ?? {}).map(([k, v]) => [k, typeof v === "string" ? scrub(v, secretValues).slice(0, 120) : v]));
      return { ok: true, info };
    }
    return { ok: false, code: result.code, message: scrub(String(result.message ?? ""), secretValues).slice(0, 300), ...(result.hint ? { hint: scrub(result.hint, secretValues).slice(0, 300) } : {}) };
  }

  async function slicerChoices(config: MorphixConfig): Promise<SlicerChoice[]> {
    const active = config.printers.find((p) => p.id === config.activePrinterId);
    const model = active ? catalog().find((m) => m.id === active.modelId) : undefined;
    const adapters = deps.slicerAdapters ?? [];
    return Promise.all(
      SLICER_IDS.map(async (id): Promise<SlicerChoice> => {
        const a = adapters.find((x) => x.id === id);
        if (!a) return { id, name: SLICER_NAMES[id], installed: null };
        const install = await withTimeout(a.detect({ customPath: config.slicer.paths?.[id] }).catch(() => null), 8000, null);
        let hint: string | undefined;
        try {
          hint = install ? undefined : a.installHint({ arch: process.arch });
        } catch {
          hint = undefined;
        }
        return {
          id, name: a.name || SLICER_NAMES[id], installed: Boolean(install), version: install?.version ?? null, path: install?.path, hint,
          supportsActivePrinter: model ? safe(() => a.supports(model)) : undefined,
        };
      }),
    );
  }
}

function fieldValue(f: ConnectionField, v: unknown): string | number | boolean | undefined {
  const empty = v === undefined || v === null || v === "";
  if (empty) {
    if (f.default !== undefined) return f.default;
    if (f.required) throw new InputError(`${f.label} is required.`, f.key);
    return undefined;
  }
  switch (f.kind) {
    case "host":
      must(checkHost(v, f.label), f.key);
      return (v as string).trim();
    case "port":
      must(checkPort(v, f.label), f.key);
      return Number(v);
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e9) throw new InputError(`${f.label} must be a number.`, f.key);
      return n;
    }
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === "false") return v === "true";
      throw new InputError(`${f.label} must be on or off.`, f.key);
    case "serial-port":
      must(checkSerialPort(v, f.label), f.key);
      return v as string;
    case "text":
    default:
      must(checkText(v, f.label, { min: f.required ? 1 : 0, max: 200 }), f.key);
      return (v as string).trim();
  }
}

/** Replaces any secret value that appears in text. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join("•••");
  return out;
}

function pick(d: Discovered): Discovered {
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  return { driver: d.driver, host: d.host.trim(), port: typeof d.port === "number" && !checkPort(d.port) ? d.port : undefined, name: str(d.name, 80), model: str(d.model, 80), serial: str(d.serial, 80) };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function optionalBody(ctx: Parameters<RouteHandler>[0]): Promise<Record<string, unknown> | null> {
  const buf = await ctx.body();
  if (buf.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new InputError("The request wasn't valid JSON.");
  }
  if (raw === null) return null;
  if (!isRecord(raw)) throw new InputError("Send a JSON object.");
  return raw;
}
