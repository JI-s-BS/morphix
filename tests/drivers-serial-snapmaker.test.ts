// snapmaker driver against a fake Snapmaker 2.0 HTTP API and a fake UDP socket (no hardware, no network).
import { describe, expect, it } from "vitest";
import { createSnapmakerDriver, parseDiscoveryReply, type UdpSocketLike } from "../packages/printer/src/drivers/serial/snapmaker";

const TOKEN = "tok-5ecret-1234";

class FakeSnapmaker {
  accepted = new Set<string>([TOKEN]);
  waiting = new Set<string>();
  status: Record<string, unknown> = {
    status: "IDLE", toolHead: "TOOLHEAD_3DPRINTING_1",
    nozzleTemperature: 24.5, nozzleTargetTemperature: 0, heatedBedTemperature: 23, heatedBedTargetTemperature: 0,
  };
  posts: Array<{ path: string; token: string | null }> = [];
  prepared?: { type: string; filename: string; size: number };
  urls: string[] = [];

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    this.urls.push(url.pathname);
    expect(url.port).toBe("8080");
    const method = (init.method ?? "GET").toUpperCase();
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const tokenOf = () => (init.body instanceof FormData ? String(init.body.get("token")) : new URLSearchParams(String(init.body)).get("token"));
    if (method === "GET" && url.pathname === "/api/v1/status") {
      const t = url.searchParams.get("token") ?? "";
      if (this.waiting.has(t)) return new Response(null, { status: 204 });
      if (!this.accepted.has(t)) return json({ msg: "Unauthorized" }, 401);
      return json(this.status);
    }
    if (method !== "POST") return json({}, 404);
    const token = tokenOf();
    this.posts.push({ path: url.pathname, token });
    if (url.pathname === "/api/v1/connect") {
      if (!token) {
        this.waiting.add("new-token");
        return json({ token: "new-token" });
      }
      return this.accepted.has(token) || this.waiting.has(token) ? json({ token }) : json({}, 403);
    }
    if (!token || !this.accepted.has(token)) return json({}, 401);
    if (url.pathname === "/api/v1/prepare_print") {
      const f = init.body as FormData;
      const file = f.get("file") as File;
      this.prepared = { type: String(f.get("type")), filename: file.name, size: file.size };
      return json({});
    }
    if (url.pathname === "/api/v1/start_print") {
      if (!this.prepared) return json({}, 400);
      this.status = { ...this.status, status: "RUNNING", fileName: this.prepared.filename, progress: 0 };
      return json({});
    }
    if (["/api/v1/pause_print", "/api/v1/resume_print", "/api/v1/stop_print"].includes(url.pathname)) return json({});
    return json({}, 404);
  }) as typeof fetch;
}

function setup(config: Record<string, string> = { host: "192.168.1.60", token: TOKEN }) {
  const fake = new FakeSnapmaker();
  const driver = createSnapmakerDriver({ timeoutMs: 200 });
  return { fake, driver, conn: driver.connect(config, { fetch: fake.fetch }) };
}

describe("snapmaker driver", () => {
  it("has fields with help text and a secret token", () => {
    const { driver } = setup();
    for (const f of driver.fields) expect(f.help).toBeTruthy();
    expect(driver.fields.find((f) => f.key === "token")?.kind).toBe("secret");
  });

  it("pairs: connect returns a token, 204 while waiting for the touchscreen, then paired", async () => {
    const fake = new FakeSnapmaker();
    const { pairing } = createSnapmakerDriver({ timeoutMs: 200 });
    const started = await pairing.start({ host: "192.168.1.60" }, { fetch: fake.fetch });
    expect(started).toMatchObject({ state: "waiting", save: { token: "new-token" } });
    const cfg = { host: "192.168.1.60", token: "new-token" };
    expect((await pairing.check(cfg, { fetch: fake.fetch })).state).toBe("waiting");
    fake.waiting.delete("new-token");
    fake.accepted.add("new-token");
    expect((await pairing.check(cfg, { fetch: fake.fetch })).state).toBe("paired");
    fake.accepted.delete("new-token");
    expect((await pairing.check(cfg, { fetch: fake.fetch })).state).toBe("denied");
  });

  it("test() works with a token and reports 'auth' without one or with a refused one", async () => {
    expect(await setup().conn.test()).toMatchObject({ ok: true });
    expect(await setup({ host: "192.168.1.60" }).conn.test()).toMatchObject({ ok: false, code: "auth", hint: expect.stringMatching(/Yes/) });
    const bad = await setup({ host: "192.168.1.60", token: "nope-secret" }).conn.test();
    expect(bad).toMatchObject({ ok: false, code: "auth" });
    expect(JSON.stringify(bad)).not.toContain("nope-secret");
  });

  it("maps status, temperatures, progress, and refuses laser / CNC heads", async () => {
    const { fake, conn } = setup();
    expect(await conn.status()).toMatchObject({ state: "idle", temps: { nozzle: { actual: 24.5, target: 0 }, bed: { actual: 23, target: 0 } } });
    fake.status = { ...fake.status, status: "RUNNING", fileName: "cube.gcode", progress: 0.4, elapsedTime: 600, remainingTime: 900 };
    expect(await conn.status()).toMatchObject({ state: "printing", message: "Printing cube.gcode", job: { file: "cube.gcode", progress: 0.4, elapsedS: 600, remainingS: 900 } });
    fake.status = { ...fake.status, progress: 55 };
    expect((await conn.status()).job?.progress).toBeCloseTo(0.55);
    fake.status = { ...fake.status, status: "PAUSED", isFilamentOut: true };
    expect(await conn.status()).toMatchObject({ state: "paused", message: expect.stringMatching(/Filament ran out/) });
    fake.status = { ...fake.status, status: "IDLE", isFilamentOut: false, toolHead: "TOOLHEAD_LASER_1" };
    expect((await conn.status()).state).toBe("busy");
    expect(await conn.test()).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("uploads and starts (prepare_print + start_print), then pause / resume / stop", async () => {
    const { fake, conn } = setup();
    await conn.upload({ name: "cube.gcode", data: Buffer.alloc(1000, 65), format: "gcode" });
    expect(fake.prepared).toBeUndefined();
    await conn.start("cube.gcode");
    expect(fake.prepared).toEqual({ type: "3DP", filename: "cube.gcode", size: 1000 });
    expect(fake.posts.map((p) => p.path)).toEqual(["/api/v1/connect", "/api/v1/prepare_print", "/api/v1/start_print"]);
    expect(fake.posts.every((p) => p.token === TOKEN)).toBe(true);
    await expect(conn.start("cube.gcode")).rejects.toMatchObject({ code: "busy" });
    await conn.pause();
    fake.status = { ...fake.status, status: "PAUSED" };
    await expect(conn.pause()).rejects.toMatchObject({ code: "rejected" });
    await conn.resume();
    await conn.cancel();
    expect(fake.posts.slice(-3).map((p) => p.path)).toEqual(["/api/v1/pause_print", "/api/v1/resume_print", "/api/v1/stop_print"]);
  });

  it("refuses to start without an upload, or non-gcode files", async () => {
    const { conn } = setup();
    await expect(conn.start("x.gcode")).rejects.toMatchObject({ code: "rejected" });
    await expect(conn.upload({ name: "x.ufp", data: Buffer.from("x"), format: "ufp" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(conn.cancel()).rejects.toMatchObject({ code: "rejected" });
  });

  it("times out, and an unreachable printer is offline (never throws, token never shown)", async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const driver = createSnapmakerDriver({ timeoutMs: 30 });
    const slow = driver.connect({ host: "192.168.1.60", token: TOKEN }, { fetch: hang });
    expect(await slow.test()).toMatchObject({ ok: false, code: "timeout" });
    const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const down = driver.connect({ host: "192.168.1.60", token: TOKEN }, { fetch: refused });
    const s = await down.status();
    expect(s.state).toBe("offline");
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(await down.test())).not.toContain(TOKEN);
    await expect(down.start("x.gcode")).rejects.toMatchObject({ code: "unreachable" });
  });

  it("discovers printers by UDP broadcast on port 20054", async () => {
    const sent: Array<{ msg: string; port: number; addr: string }> = [];
    let onMessage: ((m: Buffer, r: { address: string; port: number }) => void) | undefined;
    let closed = false;
    const sock: UdpSocketLike = {
      on(event: string, l: unknown) { if (event === "message") onMessage = l as typeof onMessage; return sock; },
      bind(_p: number, cb: () => void) { setTimeout(cb, 0); return sock; },
      setBroadcast() {},
      send(msg: string, port: number, addr: string) {
        sent.push({ msg, port, addr });
        setTimeout(() => {
          onMessage!(Buffer.from("Snapmaker@192.168.1.60|model:Snapmaker 2 Model A350|status:IDLE"), { address: "192.168.1.60", port: 20054 });
          onMessage!(Buffer.from("garbage"), { address: "192.168.1.9", port: 20054 });
        }, 5);
      },
      close() { closed = true; },
    } as UdpSocketLike;
    const driver = createSnapmakerDriver({ createUdpSocket: () => sock });
    const found = await driver.discover!(120);
    expect(sent).toEqual([{ msg: "discover", port: 20054, addr: "255.255.255.255" }]);
    expect(found).toEqual([{ driver: "snapmaker", host: "192.168.1.60", port: 8080, name: "Snapmaker", model: "Snapmaker 2 Model A350" }]);
    expect(closed).toBe(true);
    expect(parseDiscoveryReply("J1@10.0.0.5|model:Snapmaker J1|status:IDLE|SACP:1", "10.0.0.5")?.model).toBe("Snapmaker J1");
  });
});
