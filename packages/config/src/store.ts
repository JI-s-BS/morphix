// File-backed ConfigStore (docs/GOAL.md item 5/10).
//   <dataDir>/config.json            settings (no secrets), validated on load, schema version 1
//   <dataDir>/secrets/secrets.json   API keys + printer secrets, mode 0600, dir 0700
// Writes are atomic (temp file + rename). A file that can't be read is moved aside and reported
// through issues(), never silently dropped. On the very first run, keys from an old morphix.env
// (the Raspberry Pi build) are imported once so existing users keep them.
import { chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findPrinter } from "@morphix/catalog";
import type { DriverId } from "@morphix/printer";
import type { SlicerId } from "@morphix/slicing";
import { atomicWrite, createQueue, ensureDir, exists, moveAside, readIfExists } from "./fsutil";
import { SECRET_KEYS, type ConfigStore, type ConfiguredPrinter, type MorphixConfig, type SecretKey } from "./types";
import { checkHost, checkPort, isRecord } from "./validate";

export const SLICER_IDS: readonly SlicerId[] = ["prusaslicer", "orcaslicer", "bambustudio"];
export const CONFIG_FILE = "config.json";
export const SECRETS_DIR = "secrets";
export const SECRETS_FILE = "secrets.json";

export interface StoreIssue {
  file: string;
  /** Plain text for the setup page / doctor. Never contains secret values. */
  message: string;
  movedTo?: string;
}

export interface FileConfigStore extends ConfigStore {
  readonly secretsDir: string;
  /** Problems found while loading (corrupt files moved aside, fixed fields) and notes like the legacy import. */
  issues(): StoreIssue[];
}

export interface ConfigStoreOptions {
  /** Old morphix.env files to import keys from on first run. Default: see legacyEnvCandidates(). */
  legacyEnvPaths?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): MorphixConfig {
  const port = Number(env.MORPHIX_PORT);
  return {
    version: 1,
    server: { port: checkPort(port) ? 8080 : port, bind: env.MORPHIX_BIND && !checkHost(env.MORPHIX_BIND) ? env.MORPHIX_BIND : "0.0.0.0", https: false },
    printers: [],
    slicer: {},
    features: { voice: false, aiGeneration: false, modelSearch: false, guardian: false },
    setupComplete: false,
  };
}

/** Where the Pi build kept its keys: $MORPHIX_ROOT/config/morphix.env (default ~/Morphix). */
export function legacyEnvCandidates(dataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.MORPHIX_ROOT, join(homedir(), "Morphix")].filter((r): r is string => Boolean(r));
  return [...new Set([join(dataDir, "morphix.env"), join(dataDir, "config", "morphix.env"), ...roots.map((r) => join(r, "config", "morphix.env"))])];
}

/** KEY=value lines, same rules as the old Electron loader (quotes stripped, # comments). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const PRINTER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET_NAME = /^printer:[a-z0-9][a-z0-9-]{0,39}:[A-Za-z0-9_-]{1,40}$/;

export function isSecretKey(k: unknown): k is SecretKey {
  return typeof k === "string" && ((SECRET_KEYS as readonly string[]).includes(k) || SECRET_NAME.test(k));
}

/**
 * Checks a config object. Returns the cleaned config plus what had to be fixed; `fatal` means
 * the file isn't a Morphix config at all (wrong shape or schema version).
 */
export function validateConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): { config: MorphixConfig; problems: string[]; fatal?: string } {
  const def = defaultConfig(env);
  if (!isRecord(raw)) return { config: def, problems: [], fatal: "it isn't a settings object" };
  if (raw.version !== 1) return { config: def, problems: [], fatal: `it has schema version ${JSON.stringify(raw.version) ?? "none"}, this Morphix reads version 1` };
  const problems: string[] = [];
  const c = def;

  if (raw.server !== undefined) {
    if (!isRecord(raw.server)) problems.push("server settings were not an object");
    else {
      const s = raw.server;
      if (s.port !== undefined) checkPort(s.port) ? problems.push("server.port was invalid") : (c.server.port = Number(s.port));
      if (s.bind !== undefined) typeof s.bind !== "string" || checkHost(s.bind) ? problems.push("server.bind was invalid") : (c.server.bind = s.bind);
      if (s.https !== undefined) typeof s.https !== "boolean" ? problems.push("server.https was invalid") : (c.server.https = s.https);
    }
  }

  if (raw.printers !== undefined) {
    if (!Array.isArray(raw.printers)) problems.push("printers was not a list");
    else {
      const ids = new Set<string>();
      raw.printers.forEach((p, i) => {
        const why = printerProblem(p);
        if (why || ids.has((p as ConfiguredPrinter).id)) {
          problems.push(`printer #${i + 1} was dropped (${why ?? "duplicate id"})`);
          return;
        }
        const q = p as ConfiguredPrinter;
        ids.add(q.id);
        c.printers.push({ id: q.id, name: q.name, modelId: q.modelId, driver: q.driver, connection: { ...q.connection } });
      });
    }
  }
  if (raw.activePrinterId !== undefined) {
    if (typeof raw.activePrinterId === "string" && c.printers.some((p) => p.id === raw.activePrinterId)) c.activePrinterId = raw.activePrinterId;
    else problems.push("activePrinterId didn't match a printer");
  }

  if (raw.slicer !== undefined) {
    if (!isRecord(raw.slicer)) problems.push("slicer settings were not an object");
    else {
      const s = raw.slicer;
      if (s.preferred !== undefined) {
        if (SLICER_IDS.includes(s.preferred as SlicerId)) c.slicer.preferred = s.preferred as SlicerId;
        else problems.push("slicer.preferred was not a known slicer");
      }
      if (s.paths !== undefined) {
        if (!isRecord(s.paths)) problems.push("slicer.paths was not an object");
        else
          for (const [k, v] of Object.entries(s.paths)) {
            if (SLICER_IDS.includes(k as SlicerId) && typeof v === "string" && v.startsWith("/") && v.length <= 512) (c.slicer.paths ??= {})[k as SlicerId] = v;
            else problems.push(`slicer path for ${k.slice(0, 20)} was invalid`);
          }
      }
    }
  }

  if (raw.features !== undefined) {
    if (!isRecord(raw.features)) problems.push("features were not an object");
    else
      for (const k of Object.keys(c.features) as (keyof MorphixConfig["features"])[]) {
        const v = raw.features[k];
        if (v === undefined) continue;
        if (typeof v === "boolean") c.features[k] = v;
        else problems.push(`features.${k} was not true/false`);
      }
  }

  if (raw.setupComplete !== undefined) {
    if (typeof raw.setupComplete === "boolean") c.setupComplete = raw.setupComplete;
    else problems.push("setupComplete was not true/false");
  }
  return { config: c, problems };
}

function printerProblem(p: unknown): string | null {
  if (!isRecord(p)) return "not an object";
  if (typeof p.id !== "string" || !PRINTER_ID.test(p.id)) return "bad id";
  if (typeof p.name !== "string" || p.name.length === 0 || p.name.length > 60) return "bad name";
  if (typeof p.modelId !== "string" || p.modelId.length > 80) return "bad model";
  if (typeof p.driver !== "string" || !/^[a-z0-9-]{1,40}$/.test(p.driver)) return "bad driver";
  if (!isRecord(p.connection)) return "bad connection";
  for (const [k, v] of Object.entries(p.connection)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) return "bad connection field";
    if (!["string", "number", "boolean"].includes(typeof v)) return "bad connection value";
    if (typeof v === "string" && v.length > 512) return "connection value too long";
  }
  return null;
}

interface SecretsFile {
  version: 1;
  secrets: Record<string, string>;
  /** Where keys were imported from on first run (a path, never values). */
  importedFrom?: string;
}

export function createConfigStore(dataDir: string, opts: ConfigStoreOptions = {}): FileConfigStore {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const configFile = join(dataDir, CONFIG_FILE);
  const secretsDir = join(dataDir, SECRETS_DIR);
  const secretsFile = join(secretsDir, SECRETS_FILE);
  const queue = createQueue();
  const issues: StoreIssue[] = [];
  let config: MorphixConfig | null = null;
  let secrets: SecretsFile | null = null;
  let firstRun: Promise<void> | null = null;

  const report = (i: StoreIssue) => {
    if (!issues.some((x) => x.file === i.file && x.message === i.message)) issues.push(i);
  };

  async function prepareDirs(): Promise<void> {
    if (!(await exists(dataDir))) await ensureDir(dataDir, 0o700);
    await ensureDir(secretsDir, 0o700);
  }

  async function readConfig(): Promise<MorphixConfig> {
    const text = await readIfExists(configFile);
    if (text === undefined) return defaultConfig(env);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = Symbol("unparseable");
    }
    const { config: c, problems, fatal } = validateConfig(typeof raw === "symbol" ? null : raw, env);
    if (typeof raw === "symbol" || fatal) {
      const movedTo = await moveAside(configFile, "corrupt", now());
      report({ file: configFile, movedTo, message: `config.json could not be used (${typeof raw === "symbol" ? "it isn't valid JSON" : fatal}). It was moved to ${movedTo} and Morphix started with default settings; run setup again or fix and restore that file.` });
      return c;
    }
    if (problems.length) {
      const movedTo = `${configFile}.invalid-${now().toISOString().replace(/[:.]/g, "-")}`;
      await atomicWrite(movedTo, text, 0o600);
      await atomicWrite(configFile, JSON.stringify(c, null, 2) + "\n", 0o600);
      report({ file: configFile, movedTo, message: `Some settings in config.json were invalid and were reset: ${problems.join("; ")}. The original file was kept as ${movedTo}.` });
    }
    return c;
  }

  async function readSecrets(): Promise<SecretsFile> {
    const text = await readIfExists(secretsFile);
    if (text === undefined) return { version: 1, secrets: {} };
    const st = await stat(secretsFile);
    if ((st.mode & 0o077) !== 0) {
      await chmod(secretsFile, 0o600);
      report({ file: secretsFile, message: "The secrets file could be read by other users; its permissions were fixed to owner-only (0600)." });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const ok =
      isRecord(raw) && raw.version === 1 && isRecord(raw.secrets) &&
      Object.entries(raw.secrets).every(([k, v]) => isSecretKey(k) && typeof v === "string");
    if (!ok) {
      // Never include parse details: JSON errors quote the file's contents.
      const movedTo = await moveAside(secretsFile, "corrupt", now());
      report({ file: secretsFile, movedTo, message: `The saved API keys could not be read, so the file was moved to ${movedTo} (still owner-only). Enter the keys again on the setup page.` });
      return { version: 1, secrets: {} };
    }
    const r = raw as Record<string, unknown>;
    return { version: 1, secrets: { ...(r.secrets as Record<string, string>) }, importedFrom: typeof r.importedFrom === "string" ? r.importedFrom : undefined };
  }

  /** First run only (no config.json and no secrets file yet): import an old morphix.env. */
  async function importLegacy(): Promise<void> {
    if ((await exists(configFile)) || (await exists(secretsFile))) return;
    for (const file of opts.legacyEnvPaths ?? legacyEnvCandidates(dataDir, env)) {
      let text: string | undefined;
      try {
        text = await readIfExists(file);
      } catch {
        continue; // unreadable (permissions): try the next one
      }
      if (text === undefined) continue;
      const vars = parseEnvFile(text);
      const found: Record<string, string> = {};
      for (const k of SECRET_KEYS) if (vars[k] && vars[k].trim()) found[k] = vars[k].trim();
      await atomicWrite(secretsFile, JSON.stringify({ version: 1, secrets: found, importedFrom: file } satisfies SecretsFile, null, 2) + "\n", 0o600);
      const c = defaultConfig(env);
      // The Pi build drove one Afinia QD330 at MORPHIX_PRINTER_HOST (default 192.168.10.51).
      const host = vars.MORPHIX_PRINTER_HOST || "192.168.10.51";
      const qd = findPrinter("afinia-qd330");
      if (qd && !checkHost(host)) {
        c.printers.push({ id: "qd330", name: "Afinia QD330", modelId: qd.id, driver: qd.driver as DriverId, connection: { host } });
        c.activePrinterId = "qd330";
      }
      c.features = { voice: Boolean(found.GEMINI_API_KEY), aiGeneration: Boolean(found.MESHY_API_KEY), modelSearch: Boolean(found.THINGIVERSE_TOKEN || found.GEMINI_API_KEY), guardian: Boolean(found.GEMINI_API_KEY) };
      await atomicWrite(configFile, JSON.stringify(c, null, 2) + "\n", 0o600);
      const names = Object.keys(found);
      report({ file, message: `Imported ${names.length ? names.join(", ") : "no keys"} from ${file}${c.printers.length ? " and the QD330 printer address" : ""}. You can delete the keys from that old file now.` });
      return;
    }
  }

  async function init(): Promise<void> {
    if (!firstRun) {
      firstRun = (async () => {
        await prepareDirs();
        await importLegacy();
      })();
      firstRun.catch(() => {
        firstRun = null; // let the next call retry (e.g. a disk that wasn't mounted yet)
      });
    }
    await firstRun;
  }

  async function loadSecrets(): Promise<SecretsFile> {
    await init();
    if (!secrets) secrets = await queue(async () => secrets ?? (await readSecrets()));
    return secrets;
  }

  async function writeSecrets(next: SecretsFile): Promise<void> {
    await ensureDir(secretsDir, 0o700);
    await atomicWrite(secretsFile, JSON.stringify(next, null, 2) + "\n", 0o600);
    secrets = next;
  }

  return {
    dataDir,
    secretsDir,
    issues: () => issues.map((i) => ({ ...i })),

    async load() {
      await init();
      if (!config) config = await queue(async () => config ?? (await readConfig()));
      return structuredClone(config);
    },

    async save(next) {
      const { config: clean, problems, fatal } = validateConfig(next, env);
      if (fatal || problems.length) throw new Error(`Settings not saved: ${fatal ?? problems.join("; ")}.`);
      await init();
      await queue(async () => {
        await atomicWrite(configFile, JSON.stringify(clean, null, 2) + "\n", 0o600);
        config = clean;
      });
    },

    async getSecret(key) {
      if (!isSecretKey(key)) return undefined;
      const s = await loadSecrets();
      return Object.hasOwn(s.secrets, key) ? s.secrets[key] : undefined;
    },

    async setSecret(key, value) {
      if (!isSecretKey(key)) throw new Error("Unknown secret name.");
      if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > 4096)) throw new Error("Secret value must be 1 to 4096 characters.");
      await loadSecrets();
      await queue(async () => {
        const cur = secrets ?? (await readSecrets());
        const nextSecrets = { ...cur.secrets };
        if (value === null) delete nextSecrets[key];
        else nextSecrets[key] = value;
        await writeSecrets({ ...cur, secrets: nextSecrets });
      });
    },

    async secretStatus() {
      const s = await loadSecrets();
      const out: Record<string, boolean> = {};
      for (const k of SECRET_KEYS) out[k] = Boolean(s.secrets[k]);
      for (const k of Object.keys(s.secrets)) if (!(k in out)) out[k] = Boolean(s.secrets[k]);
      return out;
    },
  };
}
