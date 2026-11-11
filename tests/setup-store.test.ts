// ConfigStore: atomic writes, permissions, corrupt / invalid files, legacy morphix.env import.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigStore, defaultConfig, parseEnvFile } from "@morphix/config";
import { atomicWrite } from "../packages/config/src/fsutil";
import { tempDir } from "./setup-helpers";

const mode = (p: string) => statSync(p).mode & 0o777;
let t: ReturnType<typeof tempDir>;
const noLegacy = { legacyEnvPaths: [] as string[], env: {} };

beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

describe("config store", () => {
  it("starts with defaults and round-trips a save", async () => {
    const s = createConfigStore(t.dir, noLegacy);
    const c = await s.load();
    expect(c).toEqual(defaultConfig({}));
    expect(c.server.port).toBe(8080);
    c.features.voice = true;
    c.printers.push({ id: "p1", name: "Garage Ender", modelId: "afinia-qd330", driver: "flashforge-tcp", connection: { host: "192.168.1.9", port: 8899 } });
    c.activePrinterId = "p1";
    await s.save(c);
    const again = await createConfigStore(t.dir, noLegacy).load();
    expect(again).toEqual(c);
    expect(mode(join(t.dir, "config.json"))).toBe(0o600);
  });

  it("returns copies, so callers can't change the cached config by accident", async () => {
    const s = createConfigStore(t.dir, noLegacy);
    const a = await s.load();
    a.setupComplete = true;
    expect((await s.load()).setupComplete).toBe(false);
  });

  it("refuses to save an invalid config", async () => {
    const s = createConfigStore(t.dir, noLegacy);
    const c = await s.load();
    (c.server as { port: number }).port = 99999;
    await expect(s.save(c)).rejects.toThrow(/server.port/);
    expect(existsSync(join(t.dir, "config.json"))).toBe(false);
  });

  it("writes atomically: concurrent saves leave one valid file and no temp files", async () => {
    const s = createConfigStore(t.dir, noLegacy);
    const base = await s.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.save({ ...base, server: { ...base.server, port: 3000 + i } })));
    const parsed = JSON.parse(readFileSync(join(t.dir, "config.json"), "utf8"));
    expect(parsed.server.port).toBe(3019);
    expect(readdirSync(t.dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("a failed write keeps the old file and removes the temp file", async () => {
    const f = join(t.dir, "x.json");
    await atomicWrite(f, "old");
    mkdirSync(join(t.dir, "dir.json"));
    await expect(atomicWrite(join(t.dir, "dir.json"), "new")).rejects.toThrow();
    expect(readFileSync(f, "utf8")).toBe("old");
    expect(readdirSync(t.dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("moves a corrupt config.json aside and reports it", async () => {
    writeFileSync(join(t.dir, "config.json"), "{ not json");
    const s = createConfigStore(t.dir, noLegacy);
    expect((await s.load()).setupComplete).toBe(false);
    const [issue] = s.issues();
    expect(issue.message).toMatch(/isn't valid JSON/);
    expect(issue.movedTo && readFileSync(issue.movedTo, "utf8")).toBe("{ not json");
    expect(existsSync(join(t.dir, "config.json"))).toBe(false);
  });

  it("moves aside a config with an unknown schema version", async () => {
    writeFileSync(join(t.dir, "config.json"), JSON.stringify({ version: 2 }));
    const s = createConfigStore(t.dir, noLegacy);
    await s.load();
    expect(s.issues()[0].message).toMatch(/schema version 2/);
  });

  it("fixes invalid fields, keeps the valid ones, and keeps a copy of the original", async () => {
    const good = { id: "p1", name: "A", modelId: "afinia-qd330", driver: "flashforge-tcp", connection: { host: "10.0.0.2" } };
    writeFileSync(join(t.dir, "config.json"), JSON.stringify({ version: 1, server: { port: "lots" }, printers: [good, { id: "BAD ID" }], setupComplete: true }));
    const s = createConfigStore(t.dir, noLegacy);
    const c = await s.load();
    expect(c.server.port).toBe(8080);
    expect(c.printers).toEqual([good]);
    expect(c.setupComplete).toBe(true);
    const [issue] = s.issues();
    expect(issue.message).toMatch(/server.port was invalid/);
    expect(issue.message).toMatch(/printer #2 was dropped/);
    expect(JSON.parse(readFileSync(issue.movedTo!, "utf8")).server.port).toBe("lots");
  });
});

describe("secret store", () => {
  it("keeps secrets in a 0600 file in a 0700 dir and only reports set / not set", async () => {
    const s = createConfigStore(t.dir, noLegacy);
    await s.setSecret("GEMINI_API_KEY", "AIza-secret-value-123");
    await s.setSecret("printer:p1:accessCode", "12345678");
    expect(await s.getSecret("GEMINI_API_KEY")).toBe("AIza-secret-value-123");
    expect(mode(join(t.dir, "secrets"))).toBe(0o700);
    expect(mode(join(t.dir, "secrets", "secrets.json"))).toBe(0o600);
    const status = await s.secretStatus();
    expect(status).toMatchObject({ GEMINI_API_KEY: true, MESHY_API_KEY: false, "printer:p1:accessCode": true });
    expect(JSON.stringify(status)).not.toContain("secret-value");
    await s.save(await s.load());
    expect(readFileSync(join(t.dir, "config.json"), "utf8")).not.toContain("secret-value");
    await s.setSecret("GEMINI_API_KEY", null);
    expect(await createConfigStore(t.dir, noLegacy).getSecret("GEMINI_API_KEY")).toBeUndefined();
  });

  it("rejects unknown secret names", async () => {
    const s = createConfigStore(t.dir, noLegacy);
    await expect(s.setSecret("PATH" as never, "x")).rejects.toThrow(/Unknown secret/);
    expect(await s.getSecret("printer:../x:y" as never)).toBeUndefined();
  });

  it("tightens a secrets file other users could read", async () => {
    mkdirSync(join(t.dir, "secrets"), { mode: 0o755 });
    writeFileSync(join(t.dir, "secrets", "secrets.json"), JSON.stringify({ version: 1, secrets: { MESHY_API_KEY: "msy_abcdefgh" } }));
    chmodSync(join(t.dir, "secrets", "secrets.json"), 0o644);
    const s = createConfigStore(t.dir, noLegacy);
    expect(await s.getSecret("MESHY_API_KEY")).toBe("msy_abcdefgh");
    expect(mode(join(t.dir, "secrets"))).toBe(0o700);
    expect(mode(join(t.dir, "secrets", "secrets.json"))).toBe(0o600);
    expect(s.issues()[0].message).toMatch(/permissions were fixed/);
  });

  it("moves a corrupt secrets file aside without quoting it", async () => {
    mkdirSync(join(t.dir, "secrets"), { mode: 0o700 });
    writeFileSync(join(t.dir, "secrets", "secrets.json"), '{"version":1,"secrets":{"GEMINI_API_KEY":"AIza-leaky-key', { mode: 0o600 });
    const s = createConfigStore(t.dir, noLegacy);
    expect(await s.getSecret("GEMINI_API_KEY")).toBeUndefined();
    const [issue] = s.issues();
    expect(issue.message).toMatch(/could not be read/);
    expect(issue.message).not.toContain("leaky");
    expect(mode(issue.movedTo!)).toBe(0o600);
    expect(readFileSync(issue.movedTo!, "utf8")).toContain("leaky"); // kept, not lost
  });
});

describe("legacy morphix.env import", () => {
  const env = [
    "# Phase 2",
    "GEMINI_API_KEY=AIza-legacy-gemini",
    'MESHY_API_KEY="msy_legacy_meshy"',
    "ANTHROPIC_API_KEY=",
    "# THINGIVERSE_TOKEN=commented-out",
    "MORPHIX_PRINTER_HOST=192.168.10.77",
  ].join("\n");

  it("parses KEY=value lines like the old loader", () => {
    expect(parseEnvFile(env)).toMatchObject({ GEMINI_API_KEY: "AIza-legacy-gemini", MESHY_API_KEY: "msy_legacy_meshy", ANTHROPIC_API_KEY: "" });
    expect(parseEnvFile(env).THINGIVERSE_TOKEN).toBeUndefined();
  });

  it("imports keys and the QD330 once, on first run", async () => {
    const file = join(t.dir, "old", "morphix.env");
    mkdirSync(join(t.dir, "old"));
    writeFileSync(file, env);
    const data = join(t.dir, "data");
    const s = createConfigStore(data, { legacyEnvPaths: [join(t.dir, "missing.env"), file], env: {} });
    expect(await s.getSecret("GEMINI_API_KEY")).toBe("AIza-legacy-gemini");
    expect(await s.getSecret("MESHY_API_KEY")).toBe("msy_legacy_meshy");
    expect(await s.getSecret("ANTHROPIC_API_KEY")).toBeUndefined();
    const c = await s.load();
    expect(c.printers).toEqual([{ id: "qd330", name: "Afinia QD330", modelId: "afinia-qd330", driver: "flashforge-tcp", connection: { host: "192.168.10.77" } }]);
    expect(c.features.voice).toBe(true);
    const note = s.issues().map((i) => i.message).join(" ");
    expect(note).toMatch(/Imported GEMINI_API_KEY, MESHY_API_KEY/);
    expect(note).not.toContain("legacy-gemini");
    expect(mode(join(data, "secrets", "secrets.json"))).toBe(0o600);

    // Deleting an imported key sticks: no re-import on the next start.
    await s.setSecret("GEMINI_API_KEY", null);
    const s2 = createConfigStore(data, { legacyEnvPaths: [file], env: {} });
    expect(await s2.getSecret("GEMINI_API_KEY")).toBeUndefined();
    expect(s2.issues()).toEqual([]);
  });

  it("does not import over an existing install", async () => {
    const file = join(t.dir, "morphix.env");
    writeFileSync(file, env);
    const data = join(t.dir, "data");
    await createConfigStore(data, noLegacy).save(defaultConfig({}));
    const s = createConfigStore(data, { legacyEnvPaths: [file], env: {} });
    expect(await s.getSecret("GEMINI_API_KEY")).toBeUndefined();
  });
});
