// elegoo-sdcp driver against an injected SDCP v3 WebSocket fake, a fake upload endpoint, and a
// real UDP responder on loopback for the "M99999" probe.
import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { createElegooSdcpDriver, mapSdcpStatus, sdcpProbe, sdcpToStatus } from "../packages/printer/src/drivers/lan/elegoo-sdcp";
import { fakeFetch, fakeWebSocket, useCleanup, type FakeWsPeer } from "./drivers-lan-helpers";

const ID = "000000000001d354";

function fakeCentauri(initial: { cur?: number; print?: number } = {}, opts: { ackStart?: number; ignore?: number[]; silent?: boolean } = {}) {
  const status: Record<string, unknown> = {
    CurrentStatus: [initial.cur ?? 0],
    PrintInfo: { Status: initial.print ?? 0, CurrentLayer: 0, TotalLayer: 0, Filename: "", Progress: 0, CurrentTicks: 0, TotalTicks: 0 },
    TempOfNozzle: 26,
    TempTargetNozzle: 0,
    TempOfHotbed: 25,
    TempTargetHotbed: 0,
    TempOfBox: 24,
  };
  const pushStatus = (peer: FakeWsPeer) => peer.push({ Status: status, MainboardID: ID, TimeStamp: 1, Topic: `sdcp/status/${ID}` });
  const setPrint = (cur: number, ps: number, extra: Record<string, unknown> = {}) => {
    status.CurrentStatus = [cur];
    status.PrintInfo = { ...(status.PrintInfo as object), Status: ps, ...extra };
  };
  const requests: Record<string, unknown>[] = [];
  const ws = fakeWebSocket((text, peer) => {
    if (text === "ping") return peer.push("pong");
    if (opts.silent) return;
    const m = JSON.parse(text) as { Data: { Cmd: number; Data: Record<string, unknown>; RequestID: string; MainboardID: string }; Topic: string };
    requests.push(m.Data);
    let ack = 0;
    const cmd = m.Data.Cmd;
    const st = (status.CurrentStatus as number[])[0];
    if (!opts.ignore?.includes(cmd)) {
      if (cmd === 128) {
        ack = opts.ackStart ?? (st !== 0 ? 1 : 0);
        if (ack === 0) setPrint(1, 13, { Filename: m.Data.Data.Filename, TotalLayer: 100, CurrentLayer: 1, Progress: 1, CurrentTicks: 10, TotalTicks: 3600 });
      } else if (cmd === 129) setPrint(1, 6);
      else if (cmd === 131) setPrint(1, 13);
      else if (cmd === 130) setPrint(0, 8);
    }
    peer.push({ Id: "x", Data: { Cmd: cmd, Data: { Ack: ack }, RequestID: m.Data.RequestID, MainboardID: ID, TimeStamp: 1 }, Topic: `sdcp/response/${ID}` });
    if (cmd === 1) peer.push({ Attributes: { Name: "CC", MachineName: "Centauri Carbon", FirmwareVersion: "V1.1.29", MainboardID: ID }, MainboardID: ID, Topic: `sdcp/attributes/${ID}` });
    else pushStatus(peer);
  });
  return { ...ws, status, requests, setPrint };
}

const FAST = { requestTimeoutMs: 200, openTimeoutMs: 200, confirmTimeoutMs: 300, pollMs: 10 };

describe("elegoo-sdcp: mapping", () => {
  it("uses the machine status first, then the Centauri Carbon print sub-status", () => {
    const m = (cur: number, ps?: number) => mapSdcpStatus({ CurrentStatus: [cur], PrintInfo: ps === undefined ? {} : { Status: ps } }).state;
    expect(m(0)).toBe("idle");
    expect(m(0, 9)).toBe("idle");
    expect(m(0, 6)).toBe("paused");
    expect(m(1, 13)).toBe("printing");
    expect(m(1, 20)).toBe("printing");
    expect(m(1, 16)).toBe("heating");
    expect(m(1, 6)).toBe("paused");
    expect(m(1, 5)).toBe("paused");
    expect(m(1, 7)).toBe("busy");
    expect(m(1, 14)).toBe("error");
    expect(m(1, 9)).toBe("finishing");
    expect(m(2)).toBe("busy");
    expect(m(9)).toBe("busy");
    expect(m(8)).toBe("idle");
    expect(m(99)).toBe("busy");
    expect(mapSdcpStatus({}).state).toBe("busy");
  });

  it("builds temps and job progress", () => {
    const s = sdcpToStatus({ CurrentStatus: [1], PrintInfo: { Status: 13, Filename: "/local/a.gcode", CurrentLayer: 50, TotalLayer: 200, Progress: 25, CurrentTicks: 600, TotalTicks: 2400 }, TempOfNozzle: 220, TempTargetNozzle: 220, TempOfHotbed: 60, TempTargetHotbed: 60 }, "t");
    expect(s).toMatchObject({ state: "printing", job: { file: "a.gcode", progress: 0.25, layer: [50, 200], elapsedS: 600, remainingS: 1800 }, temps: { nozzle: { actual: 220, target: 220 } } });
  });
});

describe("elegoo-sdcp: against a fake printer", () => {
  const cleanup = useCleanup();

  function conn(p: ReturnType<typeof fakeCentauri>, f: typeof fetch = fakeFetch(() => [200, { code: "000000", success: true }]).fetch) {
    const c = createElegooSdcpDriver(FAST).connect({ host: "192.168.1.20", mainboardId: ID }, { WebSocket: p.WebSocket, fetch: f });
    cleanup(() => c.close());
    return c;
  }

  it("test() reads attributes; status() maps temps", async () => {
    const p = fakeCentauri();
    const c = conn(p);
    expect(await c.test()).toEqual({ ok: true, info: { model: "Centauri Carbon", firmware: "V1.1.29", serial: ID, name: "CC" } });
    const s = await c.status();
    expect(s.state).toBe("idle");
    expect(s.temps?.bed).toEqual({ actual: 25, target: 0 });
    const req = p.requests[0];
    expect(req).toMatchObject({ Cmd: 0, MainboardID: ID, From: 0 });
  });

  it("uploads in chunks with MD5, then starts /local/<file>", async () => {
    const p = fakeCentauri();
    const up = fakeFetch(() => [200, { code: "000000", messages: null, data: {}, success: true }]);
    const c = createElegooSdcpDriver({ ...FAST, chunkBytes: 4 }).connect({ host: "192.168.1.20", mainboardId: ID }, { WebSocket: p.WebSocket, fetch: up.fetch });
    cleanup(() => c.close());
    await c.upload({ name: "part one.gcode", data: Buffer.from("G28\nG1 X1\n"), format: "gcode" });
    expect(up.calls.map((x) => x.form!.get("Offset"))).toEqual(["0", "4", "8"]);
    expect(up.calls[0].url).toBe("http://192.168.1.20:3030/uploadFile/upload");
    expect(up.calls[0].form!.get("S-File-MD5")).toMatch(/^[0-9a-f]{32}$/);
    expect(up.calls[0].form!.get("TotalSize")).toBe("10");
    expect((up.calls[0].form!.get("File") as File).name).toBe("part_one.gcode");
    await c.start("part one.gcode");
    expect(p.requests.find((r) => r.Cmd === 128)!.Data).toMatchObject({ Filename: "/local/part_one.gcode", StartLayer: 0 });
    expect((await c.status()).state).toBe("printing");
  });

  it("an upload error from the printer is a plain rejection", async () => {
    const p = fakeCentauri();
    const up = fakeFetch(() => [200, { code: "111111", messages: [{ field: "common_field", message: -3 }], data: null, success: false }]);
    await expect(conn(p, up.fetch).upload({ name: "a.gcode", data: Buffer.from("x"), format: "gcode" })).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses to start while printing; maps printer Ack codes", async () => {
    const p = fakeCentauri({ cur: 1, print: 13 });
    const c = conn(p);
    await expect(c.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    expect(p.requests.some((r) => r.Cmd === 128)).toBe(false);
    const q = fakeCentauri({}, { ackStart: 2 });
    await expect(conn(q).start("missing.gcode")).rejects.toMatchObject({ code: "rejected", message: expect.stringContaining("not found") });
  });

  it("pause, resume and cancel", async () => {
    const p = fakeCentauri({ cur: 1, print: 13 });
    const c = conn(p);
    await c.pause();
    expect((await c.status()).state).toBe("paused");
    await c.resume();
    expect((await c.status()).state).toBe("printing");
    await c.cancel();
    expect((await c.status()).state).toBe("idle");
    expect(p.requests.map((r) => Number(r.Cmd)).filter((x) => x >= 128)).toEqual([129, 131, 130]);
  });

  it("an acknowledged command that changes nothing is a protocol error", async () => {
    const p = fakeCentauri({ cur: 1, print: 13 }, { ignore: [129] });
    await expect(conn(p).pause()).rejects.toMatchObject({ code: "protocol" });
  });

  it("a silent printer times out; test()/status() never throw", async () => {
    const p = fakeCentauri({}, { silent: true });
    const c = conn(p);
    expect(await c.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await c.status()).state).toBe("offline");
  });

  it("an unreachable or never-opening WebSocket gives ok:false / offline", async () => {
    const refuse = fakeWebSocket(() => undefined, { refuse: true });
    const c = createElegooSdcpDriver(FAST).connect({ host: "192.168.1.20", mainboardId: ID }, { WebSocket: refuse.WebSocket });
    expect(await c.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await c.status()).state).toBe("offline");
    const hang = fakeWebSocket(() => undefined, { neverOpen: true });
    const d = createElegooSdcpDriver(FAST).connect({ host: "192.168.1.20", mainboardId: ID }, { WebSocket: hang.WebSocket });
    expect(await d.test()).toMatchObject({ ok: false, code: "timeout" });
  });

  it("learns the mainboard ID over UDP when it is not configured", async () => {
    const udp = createSocket("udp4");
    udp.on("message", (msg, rinfo) => {
      if (msg.toString() === "M99999") udp.send(JSON.stringify({ Id: "x", Data: { Name: "CC", MachineName: "Centauri Carbon", MainboardIP: "127.0.0.1", MainboardID: ID, ProtocolVersion: "V3.0.0" } }), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
    cleanup(() => udp.close());
    const port = udp.address().port;
    expect((await sdcpProbe("127.0.0.1", port, 500))[0]).toMatchObject({ Data: { MainboardID: ID } });
    const p = fakeCentauri();
    const c = createElegooSdcpDriver({ ...FAST, discoveryPort: port }).connect({ host: "127.0.0.1" }, { WebSocket: p.WebSocket });
    cleanup(() => c.close());
    expect((await c.status()).state).toBe("idle");
    expect(p.requests[0].MainboardID).toBe(ID);
  });
});
