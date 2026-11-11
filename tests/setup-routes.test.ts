// Setup API: access rules, API keys (never echoed), printers CRUD + test + discovery, slicer,
// features, finish, and input validation. Uses a fake driver, catalog, fetch and slicer adapter.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrinterModel } from "@morphix/catalog";
import type { DriverConfig, PrinterConnection, PrinterDriver } from "@morphix/printer";
import type { SlicerAdapter } from "@morphix/slicing";
import { createAuth, createConfigStore, setupRoutes, type Auth, type FileConfigStore } from "@morphix/config";
import { TestRouter, cookieFrom, tempDir } from "./setup-helpers";

const ACCESS_CODE = "ac-9f8e7d6c";
const GEMINI = "AIzaSy-test-key-0123456789";

const model = (id: string, extra: Partial<PrinterModel> = {}): PrinterModel => ({
  id, brand: "Bambu Lab", model: id.toUpperCase(), driver: "bambu-lan", bed: { x: 256, y: 256, z: 256 }, origin: "corner", nozzleMm: 0.4,
  filamentMm: 1.75, gcodeFlavor: "bambu", fileFormat: "gcode.3mf", heatedBed: true, maxNozzleC: 300, maxBedC: 110,
  setupDoc: "docs/printers/bambu.md", verified: "protocol", ...extra,
});
const CATALOG: PrinterModel[] = [
  model("bambu-p1s"),
  { ...model("prusa-mk4"), brand: "Prusa", driver: "prusalink", altDrivers: ["octoprint"], setupDoc: "docs/printers/prusa.md" },
  { ...model("no-driver"), brand: "Other", driver: "duet" },
];

const tested: DriverConfig[] = [];
let closed = 0;
function fakeDriver(id: "bambu-lan" | "prusalink" | "octoprint", fields: PrinterDriver["fields"], extra: Partial<PrinterDriver> = {}): PrinterDriver {
  return {
    id, name: `Fake ${id}`, description: "fake", fields,
    connect(config): PrinterConnection {
      return {
        driver: id,
        capabilities: () => { throw new Error("unused"); },
        async test() {
          tested.push({ ...config });
          if (config.host === "10.0.0.66") return { ok: false, code: "auth", message: `Access code ${String(config.accessCode)} was rejected`, hint: "Check the code" };
          if (config.host === "10.0.0.77") return new Promise(() => undefined); // never answers
          return { ok: true, info: { model: "P1S", serial: "01P00A" } };
        },
        status: async () => ({ state: "idle", checkedAt: "" }),
        upload: async () => undefined, start: async () => undefined, pause: async () => undefined, resume: async () => undefined, cancel: async () => undefined,
        close: async () => void closed++,
      };
    },
    ...extra,
  };
}
const DRIVERS: PrinterDriver[] = [
  fakeDriver("bambu-lan", [
    { key: "host", label: "Printer IP address", kind: "host", required: true, help: "Settings → Network on the printer screen." },
    { key: "serial", label: "Serial number", kind: "text", required: true },
    { key: "accessCode", label: "LAN access code", kind: "secret", required: true },
  ], { discover: async () => [{ driver: "bambu-lan", host: "10.0.0.50", name: "Garage P1S", serial: "01P00A" }, { driver: "bambu-lan", host: "not a host!", name: "junk" }] }),
  fakeDriver("prusalink", [
    { key: "host", label: "Host", kind: "host", required: true },
    { key: "port", label: "Port", kind: "port", required: false, default: 80 },
    { key: "apiKey", label: "API key", kind: "secret", required: false },
  ]),
  fakeDriver("octoprint", [
    { key: "host", label: "Host", kind: "host", required: true },
    { key: "port", label: "Port", kind: "port", required: false, default: 5000 },
    { key: "serialPort", label: "Serial", kind: "serial-port", required: false },
  ]),
];

const ADAPTERS: SlicerAdapter[] = [
  {
    id: "orcaslicer", name: "OrcaSlicer",
    detect: async () => ({ id: "orcaslicer", path: "/usr/bin/orca-slicer", version: "2.3.0", via: "path" }),
    supports: () => true, slice: async () => ({ ok: false, reason: "unsupported-printer", message: "" }), installHint: () => "",
  },
  {
    id: "prusaslicer", name: "PrusaSlicer", detect: async () => null, supports: (p) => p.fileFormat !== "gcode.3mf",
    slice: async () => ({ ok: false, reason: "unsupported-printer", message: "" }), installHint: () => "sudo apt install prusa-slicer",
  },
];

let t: ReturnType<typeof tempDir>;
let store: FileConfigStore;
let auth: Auth;
let router: TestRouter;
let fetched: { url: string; headers: Record<string, string> }[];
let fetchStatus: number | "hang" | "down";

const fakeFetch: typeof fetch = async (input, init) => {
  fetched.push({ url: String(input), headers: init?.headers as Record<string, string> });
  if (fetchStatus === "down") throw new TypeError("fetch failed");
  if (fetchStatus === "hang") {
    return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));
  }
  return new Response(JSON.stringify({ echoed: (init?.headers as Record<string, string>) ?? {} }), { status: fetchStatus });
};

beforeEach(() => {
  t = tempDir();
  store = createConfigStore(t.dir, { legacyEnvPaths: [], env: {} });
  auth = createAuth(store);
  router = new TestRouter(auth);
  auth.routes(router);
  setupRoutes({ store, auth, catalog: CATALOG, drivers: DRIVERS, slicerAdapters: ADAPTERS, fetch: fakeFetch, issues: store.issues, printerTestTimeoutMs: 200, keyTestTimeoutMs: 100 })(router);
  fetched = [];
  fetchStatus = 200;
  tested.length = 0;
});
afterEach(() => t.cleanup());

async function admin(): Promise<string> {
  return cookieFrom(await router.request("POST", "/api/auth/setup", { body: { name: "owner", password: "longpassword" } }));
}
const allReplies = () => router.transcript.join("\n");

describe("access", () => {
  it("status is public but only shows details to the admin", async () => {
    expect((await router.request("GET", "/api/setup/status")).body).toEqual({ setupOpen: true, setupComplete: false });
    const c = await admin();
    expect((await router.request("GET", "/api/setup/status")).body).toEqual({ setupOpen: false, setupComplete: false });
    const full = await router.request("GET", "/api/setup/status", { cookie: c });
    expect(full.body).toMatchObject({ setupOpen: false, steps: { admin: true, printer: false, slicer: false, keys: false }, keys: { GEMINI_API_KEY: false } });
  });

  it("admin routes refuse anonymous and user accounts, even if the server forgot to check", async () => {
    const c = await admin();
    await router.request("POST", "/api/auth/users", { cookie: c, body: { name: "kid", password: "printstuff" } });
    const kid = cookieFrom(await router.request("POST", "/api/auth/login", { body: { name: "kid", password: "printstuff" } }));
    expect((await router.request("PUT", "/api/setup/keys/GEMINI_API_KEY", { body: { value: GEMINI } })).status).toBe(401);
    expect((await router.request("PUT", "/api/setup/keys/GEMINI_API_KEY", { cookie: kid, body: { value: GEMINI } })).status).toBe(403);
    // Call the handler directly, bypassing the router's access check: the handler re-checks.
    const route = router.routes.find((r) => r.method === "PUT" && r.re.test("/api/setup/keys/GEMINI_API_KEY"))!;
    let status = 0;
    await route.handler({ params: { key: "GEMINI_API_KEY" }, user: { name: "kid", role: "user" }, send: (s: number) => void (status = s) } as never);
    expect(status).toBe(403);
    expect(await store.getSecret("GEMINI_API_KEY")).toBeUndefined();
  });

  it("before the admin exists, setup-only data is closed too", async () => {
    expect((await router.request("GET", "/api/setup/keys")).status).toBe(401);
    expect((await router.request("POST", "/api/setup/finish")).status).toBe(401);
  });
});

describe("API keys", () => {
  it("saves a key, reports set / not set, never sends it back", async () => {
    const c = await admin();
    const put = await router.request("PUT", "/api/setup/keys/GEMINI_API_KEY", { cookie: c, body: { value: `  ${GEMINI}\n`.trim() } });
    expect(put.status).toBe(200);
    expect(put.body.features).toMatchObject({ voice: true, guardian: true, modelSearch: true, aiGeneration: false });
    expect(await store.getSecret("GEMINI_API_KEY")).toBe(GEMINI);
    const list = await router.request("GET", "/api/setup/keys", { cookie: c });
    expect(list.body.keys.find((k: { key: string }) => k.key === "GEMINI_API_KEY")).toMatchObject({ set: true, label: "Google Gemini" });
    expect(list.body.keys).toHaveLength(4);
    await router.request("GET", "/api/setup/status", { cookie: c });
    expect(allReplies()).not.toContain(GEMINI);
    const del = await router.request("DELETE", "/api/setup/keys/GEMINI_API_KEY", { cookie: c });
    expect(del.body.features).toMatchObject({ voice: false, guardian: false, modelSearch: false });
  });

  it("tests a key with a short timeout and plain answers, without echoing it", async () => {
    const c = await admin();
    const ok = await router.request("POST", "/api/setup/keys/GEMINI_API_KEY/test", { cookie: c, body: { value: GEMINI } });
    expect(ok.body.result).toEqual({ ok: true, message: "Google Gemini accepted the key." });
    expect(fetched[0].url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(fetched[0].url).not.toContain(GEMINI); // header only, never in a URL
    expect(fetched[0].headers["x-goog-api-key"]).toBe(GEMINI);

    fetchStatus = 401;
    expect((await router.request("POST", "/api/setup/keys/MESHY_API_KEY/test", { cookie: c, body: { value: "msy_bad_key_123" } })).body.result).toMatchObject({ ok: false, message: "Meshy rejected the key." });
    expect(fetched[1].headers.Authorization).toBe("Bearer msy_bad_key_123");
    fetchStatus = "hang";
    expect((await router.request("POST", "/api/setup/keys/ANTHROPIC_API_KEY/test", { cookie: c, body: { value: "sk-ant-xyz-123456" } })).body.result.message).toMatch(/didn't answer within/);
    fetchStatus = "down";
    expect((await router.request("POST", "/api/setup/keys/THINGIVERSE_TOKEN/test", { cookie: c, body: { value: "thingtoken123" } })).body.result).toMatchObject({ ok: false, message: "Couldn't reach Thingiverse." });
    // no body: tests the saved key, or says there isn't one
    expect((await router.request("POST", "/api/setup/keys/GEMINI_API_KEY/test", { cookie: c })).body.result.message).toBe("No key saved yet.");
    expect(allReplies()).not.toMatch(new RegExp(`${GEMINI}|msy_bad_key_123|sk-ant-xyz|thingtoken123`));
  });

  it("validates keys and key names", async () => {
    const c = await admin();
    for (const value of ["", "short", "has spaces in it", "x".repeat(600), 12345678]) {
      const r = await router.request("PUT", "/api/setup/keys/GEMINI_API_KEY", { cookie: c, body: { value } });
      expect(r.status).toBe(400);
      expect(r.body.field).toBe("value");
    }
    expect(allReplies()).not.toContain("has spaces in it");
    expect((await router.request("PUT", "/api/setup/keys/PATH", { cookie: c, body: { value: GEMINI } })).status).toBe(404);
    expect((await router.request("PUT", "/api/setup/keys/printer:x:y", { cookie: c, body: { value: GEMINI } })).status).toBe(404);
  });
});

describe("printers", () => {
  it("lists brands, models with their setup doc, and driver fields", async () => {
    const c = await admin();
    const r = await router.request("GET", "/api/setup/catalog", { cookie: c });
    expect(r.body.brands.map((b: { brand: string }) => b.brand)).toEqual(["Bambu Lab", "Other", "Prusa"]);
    const p1s = r.body.brands[0].models[0];
    expect(p1s).toMatchObject({ id: "bambu-p1s", driver: "bambu-lan", driverAvailable: true, docUrl: "https://github.com/JI-s-BS/morphix/blob/main/docs/printers/bambu.md" });
    expect(r.body.brands[1].models[0].driverAvailable).toBe(false);
    expect(r.body.drivers.find((d: { id: string }) => d.id === "bambu-lan")).toMatchObject({ canDiscover: true, fields: expect.arrayContaining([expect.objectContaining({ key: "accessCode", kind: "secret" })]) });
  });

  it("saves non-secret fields in config and secret fields in the secret store", async () => {
    const c = await admin();
    const r = await router.request("POST", "/api/setup/printers", { cookie: c, body: { name: "Garage P1S", modelId: "bambu-p1s", connection: { host: "10.0.0.50", serial: "01P00A", accessCode: ACCESS_CODE, junk: "dropped" } } });
    expect(r.status).toBe(201);
    const id = r.body.printer.id;
    expect(r.body.printer).toMatchObject({ name: "Garage P1S", driver: "bambu-lan", connection: { host: "10.0.0.50", serial: "01P00A" }, secretFields: { accessCode: true } });
    const config = await store.load();
    expect(config.printers[0].connection).toEqual({ host: "10.0.0.50", serial: "01P00A" });
    expect(config.activePrinterId).toBe(id);
    expect(await store.getSecret(`printer:${id}:accessCode`)).toBe(ACCESS_CODE);

    // edit without resending the secret keeps it; null clears an optional one
    const put = await router.request("PUT", `/api/setup/printers/${id}`, { cookie: c, body: { name: "Shop P1S", modelId: "bambu-p1s", connection: { host: "p1s.local", serial: "01P00A" } } });
    expect(put.body.printer).toMatchObject({ name: "Shop P1S", connection: { host: "p1s.local" }, secretFields: { accessCode: true } });

    // test the saved printer: the driver gets the secret, the browser doesn't
    const test = await router.request("POST", `/api/setup/printers/${id}/test`, { cookie: c });
    expect(test.body.result).toEqual({ ok: true, info: { model: "P1S", serial: "01P00A" } });
    expect(tested.at(-1)).toMatchObject({ host: "p1s.local", accessCode: ACCESS_CODE });

    expect((await router.request("DELETE", `/api/setup/printers/${id}`, { cookie: c })).status).toBe(200);
    expect(await store.getSecret(`printer:${id}:accessCode`)).toBeUndefined();
    expect((await store.load()).activePrinterId).toBeUndefined();
    expect(allReplies()).not.toContain(ACCESS_CODE);
  });

  it("tests unsaved values, scrubs secrets from driver messages, and times out", async () => {
    const c = await admin();
    const bad = await router.request("POST", "/api/setup/test-printer", { cookie: c, body: { modelId: "bambu-p1s", connection: { host: "10.0.0.66", serial: "S", accessCode: ACCESS_CODE } } });
    expect(bad.body.result).toEqual({ ok: false, code: "auth", message: "Access code ••• was rejected", hint: "Check the code" });
    const slow = await router.request("POST", "/api/setup/test-printer", { cookie: c, body: { modelId: "bambu-p1s", connection: { host: "10.0.0.77", serial: "S", accessCode: ACCESS_CODE } } });
    expect(slow.body.result).toMatchObject({ ok: false, code: "timeout" });
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBeGreaterThanOrEqual(2);
    expect(allReplies()).not.toContain(ACCESS_CODE);
    expect((await store.load()).printers).toEqual([]); // testing doesn't save
  });

  it("uses an alternative driver when the model allows it, with field defaults", async () => {
    const c = await admin();
    const r = await router.request("POST", "/api/setup/printers", { cookie: c, body: { name: "MK4", modelId: "prusa-mk4", driver: "octoprint", connection: { host: "octopi.local", serialPort: "/dev/ttyACM0" } } });
    expect(r.status).toBe(201);
    expect(r.body.printer.connection).toEqual({ host: "octopi.local", port: 5000, serialPort: "/dev/ttyACM0" });
    const wrong = await router.request("POST", "/api/setup/printers", { cookie: c, body: { name: "MK4", modelId: "prusa-mk4", driver: "bambu-lan", connection: {} } });
    expect(wrong.body).toMatchObject({ field: "driver" });
    const none = await router.request("POST", "/api/setup/printers", { cookie: c, body: { name: "X", modelId: "no-driver", connection: {} } });
    expect(none.body.error).toMatch(/can't talk to/);
  });

  it("validates every field", async () => {
    const c = await admin();
    const base = { name: "P", modelId: "prusa-mk4", connection: { host: "10.0.0.5" } };
    const cases: [unknown, string, RegExp][] = [
      [{ ...base, modelId: "nope" }, "modelId", /isn't in the list/],
      [{ ...base, name: "" }, "name", /required/],
      [{ ...base, name: "x".repeat(61) }, "name", /at most 60/],
      [{ ...base, name: "two\nlines" }, "name", /line breaks/],
      [{ ...base, connection: { host: "http://10.0.0.5/" } }, "host", /without http/],
      [{ ...base, connection: { host: "10.0.0.5:80" } }, "host", /port in its own box/],
      [{ ...base, connection: { host: "bad_host!" } }, "host", /valid IP address or host name/],
      [{ ...base, connection: { host: "999.1.1.1" } }, "host", /valid IP address/],
      [{ ...base, connection: {} }, "host", /required/],
      [{ ...base, connection: { host: "10.0.0.5", port: 70000 } }, "port", /1 to 65535/],
      [{ ...base, connection: { host: "10.0.0.5", port: "80x" } }, "port", /1 to 65535/],
      [{ ...base, driver: "octoprint", connection: { host: "a.local", serialPort: "/dev/../etc/passwd" } }, "serialPort", /device path/],
      [{ ...base, connection: "host=1" }, "connection", /object/],
    ];
    for (const [body, field, msg] of cases) {
      const r = await router.request("POST", "/api/setup/printers", { cookie: c, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.field).toBe(field);
      expect(r.body.error).toMatch(msg);
    }
    for (const host of ["192.168.1.50", "printer.local", "fe80::1", "[fd00::2]", "my-printer"]) {
      expect((await router.request("POST", "/api/setup/test-printer", { cookie: c, body: { ...base, connection: { host } } })).status, host).toBe(200);
    }
    // required secret on a new printer
    const r = await router.request("POST", "/api/setup/printers", { cookie: c, body: { name: "P", modelId: "bambu-p1s", connection: { host: "10.0.0.5", serial: "S" } } });
    expect(r.body).toMatchObject({ field: "accessCode", error: "LAN access code is required." });
    expect((await router.request("PUT", "/api/setup/printers/nope", { cookie: c, body: base })).status).toBe(404);
    expect((await router.request("PUT", "/api/setup/active-printer", { cookie: c, body: { id: "nope" } })).status).toBe(400);
  });

  it("finds printers on the LAN and maps them to catalog models", async () => {
    const c = await admin();
    const r = await router.request("POST", "/api/setup/discover", { cookie: c });
    expect(r.body.searched).toEqual(["bambu-lan"]);
    expect(r.body.found).toEqual([{ driver: "bambu-lan", host: "10.0.0.50", name: "Garage P1S", serial: "01P00A", models: ["bambu-p1s"] }]);
    expect((await router.request("POST", "/api/setup/discover", { cookie: c, body: { driver: "nope" } })).status).toBe(400);
  });
});

describe("slicer, features, finish", () => {
  it("lists slicers with detection results and saves the choice", async () => {
    const c = await admin();
    await router.request("POST", "/api/setup/printers", { cookie: c, body: { name: "P1S", modelId: "bambu-p1s", connection: { host: "10.0.0.50", serial: "S", accessCode: ACCESS_CODE } } });
    const r = await router.request("GET", "/api/setup/slicers", { cookie: c });
    expect(r.body.slicers).toEqual([
      { id: "prusaslicer", name: "PrusaSlicer", installed: false, version: null, hint: "sudo apt install prusa-slicer", supportsActivePrinter: false },
      { id: "orcaslicer", name: "OrcaSlicer", installed: true, version: "2.3.0", path: "/usr/bin/orca-slicer", supportsActivePrinter: true },
      { id: "bambustudio", name: "Bambu Studio", installed: null },
    ]);
    expect((await router.request("PUT", "/api/setup/slicer", { cookie: c, body: { preferred: "orcaslicer", paths: { orcaslicer: "/opt/orca/orca-slicer" } } })).status).toBe(200);
    expect((await store.load()).slicer).toEqual({ preferred: "orcaslicer", paths: { orcaslicer: "/opt/orca/orca-slicer" } });
    expect((await router.request("PUT", "/api/setup/slicer", { cookie: c, body: { preferred: "cura" } })).status).toBe(400);
    expect((await router.request("PUT", "/api/setup/slicer", { cookie: c, body: { preferred: "orcaslicer", paths: { orcaslicer: "orca; rm -rf /" } } })).status).toBe(400);
  });

  it("only turns on a feature whose key is set", async () => {
    const c = await admin();
    const r = await router.request("PUT", "/api/setup/features", { cookie: c, body: { voice: true } });
    expect(r).toMatchObject({ status: 400, body: { field: "voice", error: expect.stringMatching(/needs the Google Gemini key/) } });
    await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-123456789");
    expect((await router.request("PUT", "/api/setup/features", { cookie: c, body: { aiGeneration: true } })).body.features.aiGeneration).toBe(true);
    expect((await router.request("PUT", "/api/setup/features", { cookie: c, body: { voice: "yes" } })).status).toBe(400);
    expect((await router.request("PUT", "/api/setup/features", { cookie: c, body: { rootShell: true } })).status).toBe(400);
  });

  it("finish marks setup complete", async () => {
    const c = await admin();
    expect((await router.request("POST", "/api/setup/finish", { cookie: c })).body).toEqual({ setupComplete: true });
    expect((await router.request("GET", "/api/setup/status")).body).toEqual({ setupOpen: false, setupComplete: true });
    // after setup, a new key no longer flips features on by itself
    expect((await router.request("PUT", "/api/setup/keys/GEMINI_API_KEY", { cookie: c, body: { value: GEMINI } })).body.features.voice).toBe(false);
  });
});
