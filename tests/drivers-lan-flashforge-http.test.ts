// flashforge-http driver (Adventurer 5M / AD5X) against an injected fake of the port-8898 API.
import { describe, expect, it } from "vitest";
import { createFlashforgeHttpDriver, detailToStatus, mapFlashforgeHttpState } from "../packages/printer/src/drivers/lan/flashforge-http";
import { captureLog, closedPort, fakeFetch, type FetchCall } from "./drivers-lan-helpers";

const SN = "SNMMKE9A000123";
const CODE = "a1b2c3d4";

function fake5M(initial: string, opts: { ignore?: string[] } = {}) {
  const st = { status: initial, printFileName: "", printProgress: 0 };
  const files: string[] = [];
  const authed = (c: FetchCall) => (c.json ? c.json.serialNumber === SN && c.json.checkCode === CODE : c.headers.serialnumber === SN && c.headers.checkcode === CODE);
  const f = fakeFetch((c) => {
    const path = new URL(c.url).pathname;
    if (!authed(c)) return [200, { code: 1, message: "Access code is different" }];
    switch (path) {
      case "/detail":
        return [
          200,
          { code: 0, message: "Success", detail: { ...st, pid: "36", name: "Shop 5M Pro", firmwareVersion: "3.2.7", rightTemp: 30, rightTargetTemp: 0, platTemp: 25, platTargetTemp: 0, cameraStreamUrl: "http://192.168.1.9:8080/?action=stream", printLayer: 3, targetPrintLayer: 90, printDuration: 60, estimatedTime: 1200 } },
        ];
      case "/uploadGcode": {
        const file = c.form?.get("gcodeFile") as File | null;
        if (!file) return [200, { code: -1, message: "no file" }];
        files.push(file.name);
        return [200, { code: 0, message: "Success" }];
      }
      case "/printGcode": {
        if (st.status !== "ready") return [200, { code: 2, message: "busy" }];
        if (!files.includes(String(c.json!.fileName))) return [200, { code: 3, message: "no file" }];
        if (!opts.ignore?.includes("start")) Object.assign(st, { status: "printing", printFileName: c.json!.fileName, printProgress: 0.01 });
        return [200, { code: 0, message: "Success" }];
      }
      case "/control": {
        const action = (c.json!.payload as { args: { action: string } }).args.action;
        if (!opts.ignore?.includes(action)) st.status = action === "pause" ? "pause" : action === "continue" ? "printing" : "cancel";
        return [200, { code: 0, message: "Success" }];
      }
      default:
        return [404, "not found"];
    }
  });
  return { ...f, st, files };
}

const FAST = { requestTimeoutMs: 200, confirmTimeoutMs: 200, pollMs: 10 };

function conn(f: typeof fetch, cfg: Record<string, unknown> = {}, log?: ReturnType<typeof captureLog>, opts = {}) {
  return createFlashforgeHttpDriver({ ...FAST, ...opts }).connect({ host: "192.168.1.9", serialNumber: SN, checkCode: CODE, ...cfg }, { fetch: f, log: log?.log });
}

describe("flashforge-http: mapping", () => {
  it("maps every documented status string", () => {
    const m = (s: string) => mapFlashforgeHttpState(s).state;
    expect([m("ready"), m("completed"), m("cancel")]).toEqual(["idle", "idle", "idle"]);
    expect([m("heating"), m("printing"), m("pausing"), m("pause")]).toEqual(["heating", "printing", "paused", "paused"]);
    expect([m("busy"), m("calibrate_doing"), m("canceling"), m("downloading"), m("cloud_slicing"), m("sending"), m("unzipping"), m("??")]).toEqual(Array(8).fill("busy"));
    expect(m("error")).toBe("error");
  });

  it("builds a status from /detail", () => {
    const s = detailToStatus({ status: "printing", printFileName: "cube.gcode", printProgress: 0.42, printLayer: 10, targetPrintLayer: 100, printDuration: 600, estimatedTime: 900, rightTemp: 219, rightTargetTemp: 220, platTemp: 60, platTargetTemp: 60 }, "t");
    expect(s).toMatchObject({ state: "printing", job: { file: "cube.gcode", progress: 0.42, layer: [10, 100], elapsedS: 600, remainingS: 900 }, temps: { nozzle: { actual: 219, target: 220 } } });
  });
});

describe("flashforge-http: against a fake printer", () => {
  it("test() returns model and firmware; credentials never reach the log or URL", async () => {
    const p = fake5M("ready");
    const log = captureLog();
    const c = conn(p.fetch, {}, log);
    expect(await c.test()).toEqual({ ok: true, info: { model: "Adventurer 5M Pro", firmware: "3.2.7", serial: SN, name: "Shop 5M Pro" } });
    expect(c.capabilities().camera).toEqual({ kind: "mjpeg", url: "http://192.168.1.9:8080/?action=stream" });
    await c.upload({ name: "cube.gcode", data: Buffer.from("G28\n"), format: "gcode" });
    expect(p.calls.every((x) => !x.url.includes(CODE) && !x.url.includes(SN))).toBe(true);
    expect(log.text()).not.toContain(CODE);
    expect(log.text()).not.toContain(SN);
  });

  it("a wrong check code is an auth error with a hint", async () => {
    const p = fake5M("ready");
    const r = await conn(p.fetch, { checkCode: "wrong" }).test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
    if (!r.ok) {
      expect(r.hint).toMatch(/check code/);
      expect(r.message).not.toContain("wrong");
    }
  });

  it("missing credentials are reported by test()", async () => {
    const r = await createFlashforgeHttpDriver().connect({ host: "192.168.1.9" }).test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
  });

  it("uploads with headers + multipart, starts, and confirms", async () => {
    const p = fake5M("ready");
    const c = conn(p.fetch, { levelBeforePrint: true });
    await c.upload({ name: "My Cube.gcode", data: Buffer.from("G28\n"), format: "gcode" });
    const up = p.calls.find((x) => x.url.endsWith("/uploadGcode"))!;
    expect(up.headers).toMatchObject({ filesize: "4", printnow: "false", levelingbeforeprint: "true" });
    expect(p.files).toEqual(["My_Cube.gcode"]);
    await c.start("My Cube.gcode");
    expect((await c.status()).state).toBe("printing");
  });

  it("refuses start and upload while busy, without calling /printGcode", async () => {
    const p = fake5M("printing");
    const c = conn(p.fetch);
    await expect(c.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    await expect(c.upload({ name: "a.gcode", data: Buffer.from("x"), format: "gcode" })).rejects.toMatchObject({ code: "busy" });
    expect(p.calls.some((x) => x.url.endsWith("/printGcode"))).toBe(false);
  });

  it("pause, resume, cancel are sent through /control and confirmed by /detail", async () => {
    const p = fake5M("printing");
    const c = conn(p.fetch);
    await c.pause();
    expect(p.st.status).toBe("pause");
    await c.resume();
    expect(p.st.status).toBe("printing");
    await c.cancel();
    expect((await c.status()).state).toBe("idle");
  });

  it("an ignored command is a protocol error (not reported as done)", async () => {
    const p = fake5M("printing", { ignore: ["pause"] });
    await expect(conn(p.fetch).pause()).rejects.toMatchObject({ code: "protocol" });
  });

  it("times out on a hanging printer; status() does not throw", async () => {
    const f = fakeFetch(() => "hang");
    const c = conn(f.fetch, {}, undefined, { tcpStatus: async () => Promise.reject(new Error("no")) });
    expect(await c.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await c.status()).state).toBe("offline");
  });

  it("an unreachable printer gives ok:false / offline (real fetch, closed port)", async () => {
    const port = await closedPort();
    const c = createFlashforgeHttpDriver({ ...FAST, tcpStatus: async () => Promise.reject(new Error("down")) }).connect({ host: "127.0.0.1", port, serialNumber: SN, checkCode: CODE });
    expect(await c.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await c.status()).state).toBe("offline");
  });

  it("falls back to TCP 8899 status when the HTTP API does not answer", async () => {
    const port = await closedPort();
    const c = createFlashforgeHttpDriver({
      ...FAST,
      tcpStatus: async () => ({ online: true, checkedAt: "", machine: "BUILDING_FROM_SD", progress: 30, temps: { nozzle: { current: 210, target: 210 } } }),
    }).connect({ host: "127.0.0.1", port, serialNumber: SN, checkCode: CODE });
    const s = await c.status();
    expect(s.state).toBe("printing");
    expect(s.message).toContain("TCP 8899");
  });
});
