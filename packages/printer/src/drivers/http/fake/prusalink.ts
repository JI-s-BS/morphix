// A fake PrusaLink (v1 API) on 127.0.0.1 for tests and demos, built from Prusa's OpenAPI spec
// (https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml) and the Buddy firmware's HTTP
// Digest login (realm "Printer API", user "maker"). The Digest check here is written separately from
// ../digest.ts (straight from RFC 7616) so the tests are not checking the client against itself.
import { createHash, randomBytes } from "node:crypto";
import { newPrinterState, startFakeHttp, startPrinting, type FakeHttp, type FakePrinterState, type FakeRequest, type FakeResponse } from "./common";

export interface FakePrusaLinkOptions {
  /** Digest login (Buddy firmware). */
  username?: string;
  password?: string;
  /** Older firmware: X-Api-Key instead of Digest. */
  apiKey?: string;
  /** Send qop="auth" in the challenge (RFC 7616 style); default false like RFC 2069 servers. */
  qop?: boolean;
  /** Storage the printer reports: "usb" (Buddy) or "local" (Prusa Link on a Pi, MK3S+). */
  storage?: string;
  /** No /api/v1 (Prusa Link < 0.7). */
  noV1?: boolean;
}

export interface FakePrusaLink extends FakeHttp {
  printer: FakePrinterState;
  /** "ATTENTION", "BUSY", "FINISHED", "STOPPED" override the state derived from printer.state. */
  override?: string;
  jobId: number;
  /** Rotate the nonce so the next request gets a stale=true challenge. */
  expireNonce(): void;
  /** Headers of the last upload. */
  lastUploadHeaders?: Record<string, string | string[] | undefined>;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function parseAuth(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^Digest\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

export async function startFakePrusaLink(opts: FakePrusaLinkOptions = {}): Promise<FakePrusaLink> {
  const printer = newPrinterState();
  const storage = opts.storage ?? "usb";
  let nonce = randomBytes(8).toString("hex");
  let staleNonce: string | undefined;
  let fake!: FakePrusaLink;

  const challenge = (stale = false): FakeResponse => ({
    status: 401,
    headers: { "WWW-Authenticate": `Digest realm="Printer API", nonce="${nonce}"${opts.qop ? ', qop="auth"' : ""}${stale ? ", stale=true" : ""}` },
    text: "Unauthorized",
  });

  /** RFC 7616 §3.4.1 check of the Authorization header; undefined = ok. */
  const checkAuth = (req: FakeRequest): FakeResponse | undefined => {
    if (opts.apiKey) return req.headers["x-api-key"] === opts.apiKey ? undefined : { status: 401, text: "Unauthorized" };
    const h = String(req.headers.authorization ?? "");
    if (!/^Digest /i.test(h)) return challenge();
    const a = parseAuth(h);
    if (a.nonce === staleNonce) return challenge(true);
    if (a.nonce !== nonce || a.username !== (opts.username ?? "maker") || a.realm !== "Printer API") return challenge();
    const ha1 = md5(`${a.username}:Printer API:${opts.password ?? ""}`);
    const ha2 = md5(`${req.method}:${a.uri}`);
    const expected = opts.qop ? md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:auth:${ha2}`) : md5(`${ha1}:${a.nonce}:${ha2}`);
    if (opts.qop && a.qop !== "auth") return challenge();
    return a.response === expected ? undefined : challenge();
  };

  const prusaState = (): string => {
    if (fake.override) return fake.override;
    return { idle: "IDLE", printing: "PRINTING", paused: "PAUSED", error: "ERROR", complete: "FINISHED", cancelled: "STOPPED", busy: "BUSY", offline: "IDLE" }[printer.state];
  };
  const hasJob = () => printer.state === "printing" || printer.state === "paused" || fake.override === "ATTENTION";

  const handle = (req: FakeRequest): FakeResponse => {
    const denied = checkAuth(req);
    if (denied) return denied;
    const p = printer;
    if (opts.noV1 && req.path.startsWith("/api/v1/")) return { status: 404, text: "Not Found" };

    const fileRoute = /^\/api\/v1\/files\/([^/]+)\/(.+)$/.exec(req.path);
    if (fileRoute) {
      const [, st, name] = fileRoute;
      if (st !== storage) return { status: 404, json: { title: "Storage not found" } };
      if (req.method === "PUT") {
        fake.lastUploadHeaders = req.headers;
        if (p.files.has(name) && req.headers.overwrite !== "?1") return { status: 409, json: { title: "File already exists" } };
        if (Number(req.headers["content-length"]) !== req.body.length) return { status: 400, json: { title: "Length mismatch" } };
        p.files.set(name, Buffer.from(req.body));
        if (req.headers["print-after-upload"] === "?1" || req.headers["print-after-upload"] === "1") startPrinting(p, name);
        return { status: 201 };
      }
      if (req.method === "POST") {
        if (!p.files.has(name)) return { status: 404, json: { title: "File not found" } };
        if (!["IDLE", "READY", "FINISHED", "STOPPED"].includes(prusaState())) return { status: 409, json: { title: "Printer is busy" } };
        fake.override = undefined;
        fake.jobId++;
        startPrinting(p, name);
        return { status: 204 };
      }
    }

    const jobRoute = /^\/api\/v1\/job\/(\d+)(\/pause|\/resume)?$/.exec(req.path);
    if (jobRoute) {
      if (!hasJob() || Number(jobRoute[1]) !== fake.jobId) return { status: 404, json: { title: "Job not found" } };
      const action = req.method === "DELETE" ? "stop" : jobRoute[2]?.slice(1);
      if (action === "pause" && req.method === "PUT") {
        if (p.state !== "printing") return { status: 409, json: { title: "Not printing" } };
        p.state = "paused";
      } else if (action === "resume" && req.method === "PUT") {
        if (p.state !== "paused") return { status: 409, json: { title: "Not paused" } };
        p.state = "printing";
      } else if (action === "stop") {
        p.state = "cancelled";
        fake.override = undefined;
      } else return { status: 405, json: { title: "Method not allowed" } };
      return { status: 204 };
    }

    switch (`${req.method} ${req.path}`) {
      case "GET /api/version":
        return { json: { api: "2.0.0", server: "2.1.2", nozzle_diameter: 0.4, text: "PrusaLink", hostname: "fake-mk4", capabilities: { "upload-by-put": true } } };
      case "GET /api/v1/info":
        return { json: { name: "Fake MK4", hostname: "fake-mk4", serial: "SN-FAKE-0001", nozzle_diameter: 0.4, mmu: false } };
      case "GET /api/v1/status": {
        const out: Record<string, unknown> = {
          storage: { path: `/${storage}/`, name: storage, read_only: false },
          printer: { state: prusaState(), temp_nozzle: p.nozzle.actual, target_nozzle: p.nozzle.target, temp_bed: p.bed.actual, target_bed: p.bed.target, axis_z: 0.2, flow: 100, speed: 100 },
        };
        if (hasJob()) out.job = { id: fake.jobId, progress: Math.round(p.progress * 100), time_remaining: 1200, time_printing: p.elapsedS };
        return { json: out };
      }
      case "GET /api/v1/job":
        if (!hasJob()) return { status: 204 };
        return {
          json: {
            id: fake.jobId,
            state: prusaState(),
            progress: Math.round(p.progress * 100),
            time_remaining: 1200,
            time_printing: p.elapsedS,
            file: { name: p.file, display_name: p.file, path: `/${storage}`, size: p.files.get(p.file ?? "")?.length ?? 0 },
          },
        };
      default:
        return { status: 404, json: { title: "Not Found" } };
    }
  };

  const http = await startFakeHttp(handle);
  fake = Object.assign(http, {
    printer,
    jobId: 100,
    expireNonce() {
      staleNonce = nonce;
      nonce = randomBytes(8).toString("hex");
    },
  }) as FakePrusaLink;
  return fake;
}
