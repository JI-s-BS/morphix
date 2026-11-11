// A fake Moonraker (Klipper) on 127.0.0.1 for tests and demos, built from the Moonraker web API docs
// (https://moonraker.readthedocs.io/en/latest/web_api/) and Klipper's status reference. Response shapes
// follow the docs' examples ({"result": ...} envelopes, print_stats states); not recorded from hardware.
import { newPrinterState, parseMultipart, startFakeHttp, startPrinting, type FakeHttp, type FakePrinterState, type FakeRequest, type FakeResponse } from "./common";

export interface FakeMoonrakerOptions {
  /** Require this X-Api-Key (otherwise every client is trusted). */
  apiKey?: string;
  klippyState?: "ready" | "startup" | "shutdown" | "error" | "disconnected";
  stateMessage?: string;
  webcams?: { name: string; enabled?: boolean; service?: string; stream_url?: string; snapshot_url?: string }[];
}

export interface FakeMoonraker extends FakeHttp {
  printer: FakePrinterState;
  opts: FakeMoonrakerOptions;
  /** Klipper's print_stats.message (shown in the "error" state). */
  errorMessage: string;
  filamentUsed: number;
  layer?: [number, number];
}

const ok = (result: unknown): FakeResponse => ({ json: { result } });
const err = (status: number, message: string): FakeResponse => ({ status, json: { error: { code: status, message } } });

export async function startFakeMoonraker(opts: FakeMoonrakerOptions = {}): Promise<FakeMoonraker> {
  const printer = newPrinterState();
  let fake!: FakeMoonraker;

  const handle = (req: FakeRequest): FakeResponse => {
    if (opts.apiKey && req.headers["x-api-key"] !== opts.apiKey) return err(401, "Unauthorized");
    const klippy = opts.klippyState ?? "ready";
    const body = req.body.length && String(req.headers["content-type"]).includes("json") ? (JSON.parse(req.body.toString()) as Record<string, unknown>) : {};
    const p = printer;
    const klippyRoute = req.path.startsWith("/printer/");
    if (klippyRoute && klippy !== "ready" && req.path !== "/printer/info") return err(503, "Klippy Host not connected");

    switch (`${req.method} ${req.path}`) {
      case "GET /server/info":
        return ok({ klippy_connected: klippy !== "disconnected", klippy_state: klippy, moonraker_version: "v0.9.3-fake", api_version: [1, 5, 0] });
      case "GET /printer/info":
        if (klippy === "disconnected") return err(503, "Klippy Host not connected");
        return ok({ state: klippy, state_message: opts.stateMessage ?? "Printer is ready", hostname: "fake-voron", software_version: "v0.12.0-fake" });
      case "GET /printer/objects/query": {
        const status: Record<string, unknown> = {};
        const stateName = p.state === "offline" || p.state === "busy" ? "standby" : p.state === "idle" ? "standby" : p.state;
        if (req.query.has("print_stats"))
          status.print_stats = {
            filename: p.file ?? "",
            total_duration: p.elapsedS,
            print_duration: p.elapsedS,
            filament_used: fake.filamentUsed,
            state: stateName,
            message: p.state === "error" ? fake.errorMessage : "",
            info: { total_layer: fake.layer?.[1] ?? null, current_layer: fake.layer?.[0] ?? null },
          };
        if (req.query.has("extruder")) status.extruder = { temperature: p.nozzle.actual, target: p.nozzle.target, power: 0 };
        if (req.query.has("heater_bed")) status.heater_bed = { temperature: p.bed.actual, target: p.bed.target, power: 0 };
        if (req.query.has("display_status")) status.display_status = { progress: p.progress, message: null };
        if (req.query.has("virtual_sdcard")) status.virtual_sdcard = { progress: p.progress, is_active: p.state === "printing", file_position: 0 };
        return ok({ eventtime: 1234.5, status });
      }
      case "POST /server/files/upload": {
        const parts = parseMultipart(req.body, req.headers["content-type"]);
        const file = parts.find((x) => x.name === "file");
        const root = parts.find((x) => x.name === "root")?.data.toString() ?? "gcodes";
        if (!file?.filename) return err(400, "No file name");
        if (root !== "gcodes") return err(400, `Invalid root ${root}`);
        p.files.set(file.filename, Buffer.from(file.data));
        const print = parts.find((x) => x.name === "print")?.data.toString() === "true";
        if (print) startPrinting(p, file.filename);
        return { status: 201, json: { item: { path: file.filename, root }, print_started: print, print_queued: false, action: "create_file" } };
      }
      case "POST /printer/print/start": {
        const name = String(body.filename ?? req.query.get("filename") ?? "");
        if (p.state === "printing" || p.state === "paused") return err(400, "Printer is busy");
        if (!p.files.has(name)) return err(400, `File ${name} does not exist`);
        startPrinting(p, name);
        return ok("ok");
      }
      case "POST /printer/print/pause":
        if (p.state !== "printing") return err(400, "Print is not active");
        p.state = "paused";
        return ok("ok");
      case "POST /printer/print/resume":
        if (p.state !== "paused") return err(400, "Print is not paused");
        p.state = "printing";
        return ok("ok");
      case "POST /printer/print/cancel":
        if (p.state !== "printing" && p.state !== "paused") return err(400, "No print");
        p.state = "cancelled";
        p.nozzle.target = 0;
        p.bed.target = 0;
        return ok("ok");
      case "POST /printer/gcode/script": {
        const script = String(body.script ?? req.query.get("script") ?? "");
        p.gcode.push(script);
        const m = /^SET_HEATER_TEMPERATURE HEATER=(\w+) TARGET=(\d+(?:\.\d+)?)$/.exec(script);
        if (m) (m[1] === "extruder" ? p.nozzle : p.bed).target = Number(m[2]);
        return ok("ok");
      }
      case "GET /server/webcams/list":
        if (!opts.webcams) return err(404, "Not Found");
        return ok({ webcams: opts.webcams });
      default:
        return err(404, "Not Found");
    }
  };

  const http = await startFakeHttp(handle);
  fake = Object.assign(http, { printer, opts, errorMessage: "", filamentUsed: 0 }) as FakeMoonraker;
  return fake;
}
