// ultimaker driver against a fake Ultimaker local API (fetch is replaced; no hardware, no network).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUltimakerDriver } from "../packages/printer/src/drivers/serial/ultimaker";
import { parseDigestChallenge } from "../packages/printer/src/drivers/serial/http-util";
import { isPairable } from "../packages/printer/src/drivers/serial";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const REALM = "Jedi-API";
const ID = "4a1b2c3d";
const KEY = "0123456789abcdef0123456789abcdef";

interface Job { name: string; state: string; progress: number; time_elapsed: number; time_total: number }

class FakeUltimaker {
  printerStatus = "idle";
  job: Job | undefined;
  authorized = new Map<string, string>([[ID, KEY]]);
  pending = new Map<string, { key: string; answer: "unknown" | "authorized" | "unauthorized" }>();
  nonce = "n-1";
  calls: Array<{ method: string; path: string; auth: boolean }> = [];
  uploads: Array<{ jobname: string; filename: string; size: number }> = [];
  jobStates: string[] = [];

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const path = url.pathname;
    const authOk = this.checkDigest(headers.get("authorization"), method, path);
    this.calls.push({ method, path, auth: headers.has("authorization") });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const challenge = () => new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Digest realm="${REALM}", nonce="${this.nonce}", qop="auth"` } });

    if (method === "GET" && path === "/api/v1/system") return json({ name: "Lab S5", firmware: "8.3.0", variant: "Ultimaker S5", guid: "a1b2-guid" });
    if (method === "GET" && path === "/api/v1/printer") {
      return json({ status: this.printerStatus, bed: { temperature: { current: 59.5, target: 60 } }, heads: [{ extruders: [{ hotend: { temperature: { current: 210.2, target: 210 } } }] }] });
    }
    if (method === "GET" && path === "/api/v1/print_job") return this.job ? json(this.job) : json({ message: "Not found" }, 404);
    if (method === "POST" && path === "/api/v1/auth/request") {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("application")).toBe("Morphix");
      this.pending.set("new-id", { key: "new-key-secret", answer: "unknown" });
      return json({ id: "new-id", key: "new-key-secret" });
    }
    if (method === "GET" && path.startsWith("/api/v1/auth/check/")) {
      const p = this.pending.get(decodeURIComponent(path.split("/").pop()!));
      return json({ message: p?.answer ?? "unknown" });
    }
    if (method === "GET" && path === "/api/v1/auth/verify") return authOk ? json({ message: "ok" }) : challenge();
    if (method === "POST" && path === "/api/v1/print_job") {
      if (!authOk) return challenge();
      const form = init.body as FormData;
      const file = form.get("file") as File;
      this.uploads.push({ jobname: String(form.get("jobname")), filename: file.name, size: file.size });
      this.printerStatus = "printing";
      this.job = { name: String(form.get("jobname")), state: "pre_print", progress: 0, time_elapsed: 0, time_total: 3600 };
      return json({ message: "Job created" }, 201);
    }
    if (method === "PUT" && path === "/api/v1/print_job/state") {
      if (!authOk) return challenge();
      const target = JSON.parse(String(init.body)).target;
      this.jobStates.push(target);
      return json({});
    }
    return json({ message: "Not found" }, 404);
  }) as typeof fetch;

  private checkDigest(header: string | null, method: string, uri: string): boolean {
    if (!header?.startsWith("Digest ")) return false;
    const f = Object.fromEntries([...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const key = this.authorized.get(f.username);
    if (!key || f.nonce !== this.nonce || f.uri !== uri) return false;
    const ha1 = md5(`${f.username}:${REALM}:${key}`);
    const ha2 = md5(`${method}:${uri}`);
    return f.response === md5(`${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
  }
}

function setup(config: Record<string, string> = { host: "192.168.1.50", authId: ID, authKey: KEY }) {
  const fake = new FakeUltimaker();
  const driver = createUltimakerDriver({ timeoutMs: 200 });
  const conn = driver.connect(config, { fetch: fake.fetch });
  return { fake, driver, conn };
}

describe("ultimaker driver", () => {
  it("has fields with help, pairing, and a camera snapshot URL", () => {
    const { driver, conn } = setup();
    expect(isPairable(driver)).toBe(true);
    for (const f of driver.fields) expect(f.help).toBeTruthy();
    expect(driver.fields.find((f) => f.key === "authKey")?.kind).toBe("secret");
    expect(conn.capabilities().camera).toEqual({ kind: "snapshot", url: "http://192.168.1.50:8080/?action=snapshot" });
    expect(conn.capabilities().fileFormats).toEqual(["ufp", "gcode"]);
  });

  it("pairs: request → waiting until the user taps Allow → paired", async () => {
    const fake = new FakeUltimaker();
    const { pairing } = createUltimakerDriver({ timeoutMs: 200 });
    const started = await pairing.start({ host: "192.168.1.50" }, { fetch: fake.fetch });
    expect(started).toMatchObject({ state: "waiting", save: { authId: "new-id", authKey: "new-key-secret" } });
    const cfg = { host: "192.168.1.50", ...started.save };
    expect((await pairing.check(cfg, { fetch: fake.fetch })).state).toBe("waiting");
    fake.pending.get("new-id")!.answer = "authorized";
    expect((await pairing.check(cfg, { fetch: fake.fetch })).state).toBe("paired");
    fake.pending.get("new-id")!.answer = "unauthorized";
    expect((await pairing.check(cfg, { fetch: fake.fetch })).state).toBe("denied");
    // The key never appears in any message.
    expect(JSON.stringify(await pairing.check(cfg, { fetch: fake.fetch }))).not.toContain("new-key-secret");
  });

  it("test() reports printer info when paired, and 'auth' when not paired or the key is wrong", async () => {
    expect(await setup().conn.test()).toEqual({ ok: true, info: { name: "Lab S5", firmware: "8.3.0", model: "Ultimaker S5", serial: "a1b2-guid" } });
    expect(await setup({ host: "192.168.1.50" }).conn.test()).toMatchObject({ ok: false, code: "auth", hint: expect.stringMatching(/Allow/) });
    const wrong = await setup({ host: "192.168.1.50", authId: ID, authKey: "wrong" }).conn.test();
    expect(wrong).toMatchObject({ ok: false, code: "auth" });
    expect(JSON.stringify(wrong)).not.toContain("wrong");
  });

  it("maps printer and job states", async () => {
    const { fake, conn } = setup();
    let s = await conn.status();
    expect(s).toMatchObject({ state: "idle", temps: { nozzle: { actual: 210.2, target: 210 }, bed: { actual: 59.5, target: 60 } } });
    fake.printerStatus = "printing";
    fake.job = { name: "benchy", state: "printing", progress: 0.25, time_elapsed: 900, time_total: 3600 };
    s = await conn.status();
    expect(s).toMatchObject({ state: "printing", message: "Printing benchy", job: { file: "benchy", progress: 0.25, elapsedS: 900, remainingS: 2700 } });
    for (const [st, want] of [["pre_print", "heating"], ["paused", "paused"], ["pausing", "paused"], ["post_print", "finishing"], ["wait_cleanup", "finishing"], ["wait_user_action", "paused"]] as const) {
      fake.job.state = st;
      expect((await conn.status()).state).toBe(want);
    }
    fake.job = undefined;
    fake.printerStatus = "error";
    expect((await conn.status()).state).toBe("error");
    fake.printerStatus = "booting";
    expect((await conn.status()).state).toBe("busy");
  });

  it("uploads and starts a .ufp with digest auth, then pauses, resumes and aborts", async () => {
    const { fake, conn } = setup();
    await conn.upload({ name: "benchy.ufp", data: Buffer.alloc(2048, 1), format: "ufp" });
    expect(fake.calls.length).toBe(0);
    await conn.start("benchy.ufp");
    expect(fake.uploads).toEqual([{ jobname: "benchy", filename: "benchy.ufp", size: 2048 }]);
    // The upload is sent once, already signed (the nonce came from the verify GET).
    expect(fake.calls.filter((c) => c.path === "/api/v1/print_job" && c.method === "POST")).toEqual([{ method: "POST", path: "/api/v1/print_job", auth: true }]);
    await expect(conn.start("benchy.ufp")).rejects.toMatchObject({ code: "busy" });
    fake.job!.state = "printing";
    await conn.pause();
    fake.job!.state = "paused";
    await conn.resume();
    await conn.cancel();
    expect(fake.jobStates).toEqual(["pause", "print", "abort"]);
  });

  it("refuses to start unless idle, unpaired, or without an upload", async () => {
    const { fake, conn } = setup();
    await expect(conn.start("x.ufp")).rejects.toMatchObject({ code: "rejected" });
    await conn.upload({ name: "x.ufp", data: Buffer.from("x"), format: "ufp" });
    fake.job = { name: "other", state: "wait_cleanup", progress: 1, time_elapsed: 1, time_total: 1 };
    await expect(conn.start("x.ufp")).rejects.toMatchObject({ code: "busy" });
    const unpaired = setup({ host: "192.168.1.50" }).conn;
    await unpaired.upload({ name: "x.ufp", data: Buffer.from("x"), format: "ufp" });
    await expect(unpaired.start("x.ufp")).rejects.toMatchObject({ code: "auth" });
    await expect(conn.upload({ name: "x.gx", data: Buffer.from("x"), format: "gx" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(conn.pause()).rejects.toMatchObject({ code: "rejected" });
  });

  it("re-signs once when the nonce changes", async () => {
    const { fake, conn } = setup();
    expect((await conn.test()).ok).toBe(true);
    fake.nonce = "n-2";
    expect((await conn.test()).ok).toBe(true);
  });

  it("times out, and an unreachable printer is offline (never throws)", async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const driver = createUltimakerDriver({ timeoutMs: 30 });
    const slow = driver.connect({ host: "192.168.1.50", authId: ID, authKey: KEY }, { fetch: hang });
    expect(await slow.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await slow.status()).state).toBe("offline");
    const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const down = driver.connect({ host: "192.168.1.50", authId: ID, authKey: KEY }, { fetch: refused });
    expect(await down.test()).toMatchObject({ ok: false, code: "unreachable", hint: expect.stringMatching(/IP address/) });
    const s = await down.status();
    expect(s.state).toBe("offline");
    expect(s.message).not.toContain(KEY);
    expect((await driver.connect({ host: "" }, { fetch: refused }).status()).state).toBe("offline");
  });

  it("parses digest challenges", () => {
    expect(parseDigestChallenge('Digest realm="Jedi-API", nonce="abc", qop="auth", opaque="x"')).toEqual({ realm: "Jedi-API", nonce: "abc", qop: "auth", opaque: "x", algorithm: undefined });
    expect(parseDigestChallenge("Basic realm=x")).toBeUndefined();
  });
});
