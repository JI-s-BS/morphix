// A fake Duet (RepRapFirmware 3) on 127.0.0.1 for tests and demos, in either standalone mode (rr_* requests)
// or SBC mode (DuetSoftwareFramework /machine/* REST API), built from the RepRapFirmware "HTTP requests" and
// DSF "REST API" wiki pages and the object model docs. Not recorded from hardware.
import { newPrinterState, startFakeHttp, startPrinting, type FakeHttp, type FakePrinterState, type FakeRequest, type FakeResponse } from "./common";

export interface FakeDuetOptions {
  mode: "standalone" | "dsf";
  /** M551 password; undefined = none (any password accepted). */
  password?: string;
  /** Standalone: answer rr_connect with err 2 (no free sessions). */
  noFreeSessions?: boolean;
}

export interface FakeDuet extends FakeHttp {
  printer: FakePrinterState;
  /** Overrides state.status (e.g. "halted", "simulating", "off"). */
  statusOverride?: string;
  /** Forget all sessions (as if they timed out). */
  expireSessions(): void;
  /** Number of logins seen. */
  logins: number;
}

export async function startFakeDuet(opts: FakeDuetOptions): Promise<FakeDuet> {
  const printer = newPrinterState();
  const sessions = new Set<string>();
  let nextKey = 4242;
  let fake!: FakeDuet;

  const status = (): string => {
    if (fake.statusOverride) return fake.statusOverride;
    return { idle: "idle", printing: "processing", paused: "paused", error: "halted", complete: "idle", cancelled: "idle", busy: "busy", offline: "off" }[printer.state];
  };

  const model = () => {
    const p = printer;
    const size = p.files.get(p.file ?? "")?.length ?? 1000;
    const active = p.state === "printing" || p.state === "paused";
    return {
      state: { status: status(), currentTool: 0 },
      job: {
        file: active ? { fileName: `0:/gcodes/${p.file}`, size, numLayers: 50 } : { fileName: null },
        filePosition: active ? Math.round(p.progress * size) : 0,
        duration: active ? p.elapsedS : null,
        layer: active ? 10 : null,
        timesLeft: { file: active ? 900 : null, filament: null, slicer: active ? 800 : null },
      },
      heat: {
        bedHeaters: [0, -1, -1],
        chamberHeaters: [-1, -1],
        heaters: [
          { current: p.bed.actual, active: p.bed.target, standby: 0, state: p.bed.target > 0 ? "active" : "off" },
          { current: p.nozzle.actual, active: p.nozzle.target, standby: 0, state: p.nozzle.target > 0 ? "active" : "off" },
        ],
      },
      tools: [{ number: 0, heaters: [1] }],
      boards: [{ firmwareName: "RepRapFirmware for Duet 3 MB6HC", firmwareVersion: "3.5.1", name: "Duet 3 MB6HC", shortName: "MB6HC", uniqueId: "08DJM-FAKE" }],
      network: { name: "Fake Duet" },
    };
  };

  const runGcode = (code: string): string => {
    const p = printer;
    p.gcode.push(code);
    const m32 = /^M32 "0:\/gcodes\/(.+)"$/.exec(code);
    if (m32) {
      if (!p.files.has(m32[1])) return `Error: M32: GCode file "${m32[1]}" not found`;
      startPrinting(p, m32[1]);
    } else if (code === "M25" && p.state === "printing") p.state = "paused";
    else if (code === "M24" && p.state === "paused") p.state = "printing";
    else if (code === "M0" && p.state === "paused") {
      p.state = "cancelled";
      p.nozzle.target = 0;
      p.bed.target = 0;
    } else if (/^M104 S(\d+)/.test(code)) p.nozzle.target = Number(/S(\d+)/.exec(code)![1]);
    else if (/^M140 S(\d+)/.test(code)) p.bed.target = Number(/S(\d+)/.exec(code)![1]);
    else if (code === "M115") return "FIRMWARE_NAME: RepRapFirmware for Duet 3 MB6HC FIRMWARE_VERSION: 3.5.1";
    return "";
  };
  let pendingReply = "";

  const passwordOk = (pw: string | null) => opts.password === undefined || pw === opts.password;
  const authed = (req: FakeRequest) => opts.password === undefined || sessions.has(String(req.headers["x-session-key"] ?? ""));

  const standalone = (req: FakeRequest): FakeResponse => {
    if (req.path === "/rr_connect") {
      fake.logins++;
      if (opts.noFreeSessions) return { json: { err: 2 } };
      if (!passwordOk(req.query.get("password"))) return { json: { err: 1 } };
      const key = String(nextKey++);
      sessions.add(key);
      return { json: { err: 0, sessionTimeout: 8000, boardType: "duet3mb6hc", apiLevel: 2, sessionKey: Number(key) } };
    }
    if (!req.path.startsWith("/rr_")) return { status: 404, text: "<html>404 not found</html>", headers: { "Content-Type": "text/html" } };
    if (!authed(req)) return { status: 401, json: { err: 1 } };
    switch (req.path) {
      case "/rr_disconnect":
        sessions.delete(String(req.headers["x-session-key"]));
        return { json: { err: 0 } };
      case "/rr_model": {
        const key = req.query.get("key") ?? "";
        const m = model() as Record<string, unknown>;
        return { json: { key, flags: req.query.get("flags"), result: key ? m[key] : m } };
      }
      case "/rr_gcode":
        pendingReply += runGcode(req.query.get("gcode") ?? "");
        return { json: { buff: 255 } };
      case "/rr_reply": {
        const r = pendingReply;
        pendingReply = "";
        return { text: r };
      }
      case "/rr_upload": {
        const name = (req.query.get("name") ?? "").replace(/^0:\/gcodes\//, "");
        if (!name || req.method !== "POST") return { json: { err: 1 } };
        printer.files.set(name, Buffer.from(req.body));
        return { json: { err: 0 } };
      }
      default:
        return { status: 404, text: "not found" };
    }
  };

  const dsf = (req: FakeRequest): FakeResponse => {
    if (req.path.startsWith("/rr_")) return { status: 404, text: "<html>Not found</html>", headers: { "Content-Type": "text/html" } };
    if (req.path === "/machine/connect") {
      fake.logins++;
      if (!passwordOk(req.query.get("password"))) return { status: 403, text: "Forbidden" };
      const key = String(nextKey++);
      sessions.add(key);
      return { json: { sessionKey: key, sessionTimeout: 8000 } };
    }
    if (!authed(req)) return { status: 401, text: "Unauthorized" };
    if (req.method === "PUT" && req.path.startsWith("/machine/file/")) {
      const name = req.path.slice("/machine/file/".length).replace(/^0:\/gcodes\//, "");
      printer.files.set(name, Buffer.from(req.body));
      return { status: 201 };
    }
    switch (`${req.method} ${req.path}`) {
      case "GET /machine/status":
        return { json: model() };
      case "POST /machine/code":
        return { text: runGcode(req.body.toString().trim()) };
      case "GET /machine/disconnect":
        sessions.delete(String(req.headers["x-session-key"]));
        return { status: 204 };
      default:
        return { status: 404, text: "Not found" };
    }
  };

  const http = await startFakeHttp(opts.mode === "dsf" ? dsf : standalone);
  fake = Object.assign(http, { printer, logins: 0, expireSessions: () => sessions.clear() }) as FakeDuet;
  return fake;
}
