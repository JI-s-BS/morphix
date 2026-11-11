// A fake OctoPrint on 127.0.0.1 for tests and demos, built from the OctoPrint REST API docs
// (https://docs.octoprint.org/en/master/api/): X-Api-Key (403 when wrong), 409 on /api/printer when not
// connected, state flags, job progress in percent, 204 on job commands. Not recorded from hardware.
import { newPrinterState, parseMultipart, startFakeHttp, startPrinting, type FakeHttp, type FakePrinterState, type FakeRequest, type FakeResponse } from "./common";

export interface FakeOctoPrintOptions {
  apiKey: string;
  /** OctoPrint's camera settings style: 1.9+ "plugin" (classicwebcam) or ≤1.8 "legacy" (settings.webcam). */
  webcamStyle?: "plugin" | "legacy" | "none";
}

export interface FakeOctoPrint extends FakeHttp {
  printer: FakePrinterState;
  /** false = OctoPrint is up but not connected to the printer's serial port. */
  connected: boolean;
  /** Extra transitional flags (pausing, cancelling, finishing). */
  transitional?: "pausing" | "cancelling" | "finishing";
}

const err = (status: number, error: string): FakeResponse => ({ status, json: { error } });

export async function startFakeOctoPrint(opts: FakeOctoPrintOptions): Promise<FakeOctoPrint> {
  const printer = newPrinterState();
  let fake!: FakeOctoPrint;

  const stateText = (): string => {
    if (!fake.connected) return "Offline";
    if (fake.transitional) return fake.transitional[0].toUpperCase() + fake.transitional.slice(1);
    return { printing: "Printing", paused: "Paused", error: "Error: Thermal runaway", offline: "Offline" }[printer.state as string] ?? "Operational";
  };

  const handle = (req: FakeRequest): FakeResponse => {
    if (req.headers["x-api-key"] !== opts.apiKey) return err(403, "Forbidden");
    const p = printer;
    const json = req.body.length && String(req.headers["content-type"]).includes("json") ? (JSON.parse(req.body.toString()) as Record<string, unknown>) : {};
    const operational = fake.connected && p.state !== "error";

    if (req.method === "POST" && req.path.startsWith("/api/files/local/")) {
      const name = req.path.slice("/api/files/local/".length);
      if (!p.files.has(name)) return err(404, "File not found");
      if (json.command !== "select") return err(400, "Unknown command");
      if (!operational || p.state === "printing" || p.state === "paused") return err(409, "Printer is already printing or not operational");
      if (json.print) startPrinting(p, name);
      return { status: 204 };
    }

    switch (`${req.method} ${req.path}`) {
      case "GET /api/version":
        return { json: { api: "0.1", server: "1.10.2", text: "OctoPrint 1.10.2" } };
      case "GET /api/settings": {
        const s: Record<string, unknown> = { appearance: { name: "Fake Ender" } };
        if (opts.webcamStyle === "plugin") s.plugins = { classicwebcam: { stream: "/webcam/?action=stream", snapshot: "http://127.0.0.1:8080/?action=snapshot" } };
        if (opts.webcamStyle === "legacy") s.webcam = { webcamEnabled: true, streamUrl: "/webcam/?action=stream" };
        if (opts.webcamStyle === "none") s.webcam = { webcamEnabled: false };
        return { json: s };
      }
      case "GET /api/connection":
        return { json: { current: { state: fake.connected ? stateText() : "Closed", port: fake.connected ? "/dev/ttyUSB0" : null, baudrate: 115200 } } };
      case "GET /api/printer": {
        if (!fake.connected) return err(409, "Printer is not operational");
        const t = fake.transitional;
        const flags = {
          operational,
          printing: p.state === "printing" || t === "finishing",
          paused: p.state === "paused",
          pausing: t === "pausing",
          cancelling: t === "cancelling",
          finishing: t === "finishing",
          error: p.state === "error",
          ready: operational && p.state !== "printing" && p.state !== "paused",
          closedOrError: p.state === "error",
          sdReady: false,
        };
        return {
          json: {
            temperature: { tool0: { actual: p.nozzle.actual, target: p.nozzle.target, offset: 0 }, bed: { actual: p.bed.actual, target: p.bed.target, offset: 0 } },
            state: { text: stateText(), flags, ...(p.state === "error" ? { error: "Thermal runaway" } : {}) },
          },
        };
      }
      case "GET /api/job": {
        const active = p.state === "printing" || p.state === "paused";
        return {
          json: {
            job: { file: { name: p.file ?? null, display: p.file ?? null, path: p.file ?? null, origin: "local" }, estimatedPrintTime: 3600 },
            progress: { completion: active ? p.progress * 100 : null, printTime: active ? p.elapsedS : null, printTimeLeft: active ? 1800 : null, filepos: 0 },
            state: stateText(),
          },
        };
      }
      case "POST /api/files/local": {
        const parts = parseMultipart(req.body, req.headers["content-type"]);
        const file = parts.find((x) => x.name === "file");
        if (!file?.filename) return err(400, "No file included");
        if (p.state === "printing" && p.file === file.filename) return err(409, "Trying to overwrite file that is currently being printed");
        p.files.set(file.filename, Buffer.from(file.data));
        const print = parts.find((x) => x.name === "print")?.data.toString() === "true";
        if (print) startPrinting(p, file.filename);
        return { status: 201, json: { done: true, files: { local: { name: file.filename, origin: "local" } } } };
      }
      case "POST /api/job":
        if (!operational) return err(409, "Printer is not operational");
        if (json.command === "pause") {
          if (json.action === "pause" && p.state === "printing") p.state = "paused";
          else if (json.action === "resume" && p.state === "paused") p.state = "printing";
          else return err(409, "Printer is not printing");
          return { status: 204 };
        }
        if (json.command === "cancel") {
          if (p.state !== "printing" && p.state !== "paused") return err(409, "Printer is neither printing nor paused");
          p.state = "idle";
          p.file = undefined;
          return { status: 204 };
        }
        return err(400, "Unknown command");
      case "POST /api/printer/tool": {
        if (!operational) return err(409, "Printer is not operational");
        const t = (json.targets as Record<string, number> | undefined)?.tool0;
        if (json.command !== "target" || typeof t !== "number") return err(400, "Bad request");
        p.nozzle.target = t;
        return { status: 204 };
      }
      case "POST /api/printer/bed":
        if (!operational) return err(409, "Printer is not operational");
        if (json.command !== "target" || typeof json.target !== "number") return err(400, "Bad request");
        p.bed.target = json.target;
        return { status: 204 };
      case "POST /api/printer/command":
        if (!operational) return err(409, "Printer is not operational");
        p.gcode.push(...((json.commands as string[]) ?? []));
        return { status: 204 };
      default:
        return err(404, "Not Found");
    }
  };

  const http = await startFakeHttp(handle);
  fake = Object.assign(http, { printer, connected: true }) as FakeOctoPrint;
  return fake;
}
