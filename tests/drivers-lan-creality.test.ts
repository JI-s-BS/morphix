// creality-k1 driver against an injected fake of the stock port-9999 WebSocket and port-80 upload.
import { describe, expect, it } from "vitest";
import { createCrealityK1Driver, crealityToStatus, mapCrealityState } from "../packages/printer/src/drivers/lan/creality-k1";
import { fakeFetch, fakeWebSocket, useCleanup } from "./drivers-lan-helpers";

function fakeK1(initial: Record<string, unknown> = {}, opts: { ignore?: string[]; silent?: boolean } = {}) {
  // Values arrive as strings on real printers; the driver must coerce them.
  const state: Record<string, unknown> = { state: 0, model: "K1C", hostname: "K1C-1234", modelVersion: "1.3.5.22", nozzleTemp: "26.000000", targetNozzleTemp: 0, bedTemp0: "24.5", targetBedTemp0: 0, printProgress: 0, printFileName: "", err: { errcode: 0, key: 0 }, ...initial };
  const sets: Record<string, unknown>[] = [];
  const ws = fakeWebSocket(
    (text, peer) => {
      if (text === "ok") return;
      if (opts.silent) return;
      const m = JSON.parse(text) as { method: string; params: Record<string, unknown> };
      if (m.method === "get") return peer.push(state);
      sets.push(m.params);
      const p = m.params;
      const key = Object.keys(p)[0];
      if (opts.ignore?.includes(key)) return;
      const delta: Record<string, unknown> =
        key === "opGcodeFile"
          ? { state: 1, printFileName: String(p.opGcodeFile).replace(/^printprt:/, ""), printProgress: 1, layer: 1, TotalLayer: 80, printJobTime: 5, printLeftTime: 3000 }
          : key === "pause"
            ? { state: p.pause === 1 ? 5 : 1 }
            : key === "stop"
              ? { state: 4 }
              : {};
      Object.assign(state, delta);
      peer.push(delta); // deltas only, like the real printer
    },
    { onOpen: (peer) => peer.push({ ModeCode: "heart_beat", msg: "2026-11-10 10:00:00" }) },
  );
  return { ...ws, state, sets };
}

const FAST = { openTimeoutMs: 200, requestTimeoutMs: 200, confirmTimeoutMs: 300, pollMs: 10 };

describe("creality-k1: mapping", () => {
  it("maps the stock state codes", () => {
    const m = (d: Record<string, unknown>) => mapCrealityState(d).state;
    expect(m({ state: 0 })).toBe("idle");
    expect(m({ state: "1", printProgress: 40 })).toBe("printing");
    expect(m({ state: 1, printProgress: 0, nozzleTemp: "90", targetNozzleTemp: "220" })).toBe("heating");
    expect(m({ state: 2 })).toBe("idle");
    expect(m({ state: 4 })).toBe("idle");
    expect(m({ state: 5 })).toBe("paused");
    expect(m({ state: 7 })).toBe("busy");
    expect(m({ state: 9 })).toBe("busy");
    expect(m({ state: 1, withSelfTest: 40 })).toBe("busy");
    expect(m({})).toBe("busy");
    expect(m({ err: { errcode: 2001 } })).toBe("error");
    // A stale error code does not block an idle printer, but is shown.
    expect(mapCrealityState({ state: 0, err: { errcode: 2001 } })).toEqual({ state: "idle", message: "Ready (printer error code 2001)" });
  });

  it("builds the job from string values", () => {
    const s = crealityToStatus({ state: 1, printFileName: "/usr/data/printer_data/gcodes/cube.gcode", printProgress: "55", layer: "20", TotalLayer: "100", printJobTime: "600", printLeftTime: "500", nozzleTemp: "220.1", targetNozzleTemp: "220" }, "t");
    expect(s).toMatchObject({ state: "printing", job: { file: "cube.gcode", progress: 0.55, layer: [20, 100], elapsedS: 600, remainingS: 500 }, temps: { nozzle: { actual: 220.1, target: 220 } } });
  });
});

describe("creality-k1: against a fake printer", () => {
  const cleanup = useCleanup();
  function conn(p: ReturnType<typeof fakeK1>, f: typeof fetch = fakeFetch(() => [200, "ok"]).fetch, cfg: Record<string, unknown> = {}) {
    const c = createCrealityK1Driver(FAST).connect({ host: "192.168.1.30", ...cfg }, { WebSocket: p.WebSocket, fetch: f });
    cleanup(() => c.close());
    return c;
  }

  it("test() reads the model and answers the heartbeat with ok", async () => {
    const p = fakeK1();
    const c = conn(p);
    expect(await c.test()).toEqual({ ok: true, info: { model: "K1C", firmware: "1.3.5.22", name: "K1C-1234" } });
    expect(p.peers[0].sent).toContain("ok");
    expect((await c.status()).temps?.bed).toEqual({ actual: 24.5, target: 0 });
  });

  it("uploads to port 80 and starts it from the K1 gcode folder", async () => {
    const p = fakeK1();
    const up = fakeFetch(() => [200, { code: 200 }]);
    const c = conn(p, up.fetch);
    await c.upload({ name: "my cube.gcode", data: Buffer.from("G28\n"), format: "gcode" });
    expect(up.calls[0].url).toBe("http://192.168.1.30:80/upload/my_cube.gcode");
    expect((up.calls[0].form!.get("file") as File).name).toBe("my_cube.gcode");
    await c.start("my cube.gcode");
    expect(p.sets[0]).toEqual({ opGcodeFile: "printprt:/usr/data/printer_data/gcodes/my_cube.gcode" });
    expect((await c.status()).state).toBe("printing");
  });

  it("uses the K2 folder for a K2 Plus", async () => {
    const p = fakeK1({ model: "K2 Plus" });
    const c = conn(p);
    await c.start("a.gcode");
    expect(p.sets[0]).toEqual({ opGcodeFile: "printprt:/mnt/UDISK/printer_data/gcodes/a.gcode", enableSelfTest: 0 });
  });

  it("refuses start/upload while printing", async () => {
    const p = fakeK1({ state: 1, printProgress: 30 });
    const up = fakeFetch(() => [200, "ok"]);
    const c = conn(p, up.fetch);
    await expect(c.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    await expect(c.upload({ name: "a.gcode", data: Buffer.from("x"), format: "gcode" })).rejects.toMatchObject({ code: "busy" });
    expect(p.sets).toEqual([]);
    expect(up.calls).toEqual([]);
  });

  it("pause, resume and cancel", async () => {
    const p = fakeK1({ state: 1, printProgress: 30, printFileName: "/usr/data/printer_data/gcodes/a.gcode" });
    const c = conn(p);
    await c.pause();
    expect((await c.status()).state).toBe("paused");
    await c.resume();
    expect((await c.status()).state).toBe("printing");
    await c.cancel();
    expect((await c.status()).state).toBe("idle");
    expect(p.sets).toEqual([{ pause: 1 }, { pause: 0 }, { stop: 1 }]);
  });

  it("a start the printer ignores is a protocol error that points at Moonraker", async () => {
    const p = fakeK1({}, { ignore: ["opGcodeFile"] });
    const e = await conn(p).start("a.gcode").catch((x) => x);
    expect(e).toMatchObject({ code: "protocol" });
    expect(e.hint).toMatch(/Moonraker/);
  });

  it("an upload 404 says the stock upload service is missing", async () => {
    const p = fakeK1();
    await expect(conn(p, fakeFetch(() => [404, "no"]).fetch).upload({ name: "a.gcode", data: Buffer.from("x"), format: "gcode" })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("silent / unreachable printers: test() and status() never throw", async () => {
    const silent = fakeK1({}, { silent: true });
    const c = conn(silent);
    expect(await c.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await c.status()).state).toBe("offline");
    const refuse = fakeWebSocket(() => undefined, { refuse: true });
    const d = createCrealityK1Driver(FAST).connect({ host: "192.168.1.30" }, { WebSocket: refuse.WebSocket });
    expect(await d.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await d.status()).state).toBe("offline");
  });

  it("asks for the wsslicer subprotocol", async () => {
    let protocols: unknown;
    const ws = fakeWebSocket((_t, peer) => peer.push({ state: 0 }), { onOpen: (_p, _u, prot) => (protocols = prot) });
    const c = createCrealityK1Driver(FAST).connect({ host: "192.168.1.30" }, { WebSocket: ws.WebSocket });
    await c.status();
    expect(protocols).toEqual(["wsslicer"]);
    await c.close();
  });
});
