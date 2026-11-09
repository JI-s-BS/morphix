import { createHash, randomBytes, randomInt } from "node:crypto";
import { chmodSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AssistantTurn, GuardianView, JobView, PrepareSettings, PrepareSummary, PrintControlStatus, SmartModelResult, SmartSearchState, EngineChoice } from "@morphix/shared";
import type { PortalBackend, PortalUser, PrinterCommand } from "@morphix/portal";
import { sniffImage } from "@morphix/portal";
import type { Storage } from "@morphix/storage";
import { Auth0Refusal, RemoteAuth0, type RemoteAuth0Options } from "./auth0";

export { Auth0Refusal, RemoteAuth0, type RemoteAuth0Options } from "./auth0";

type Json = Record<string, unknown>;

export interface RemoteDeps {
  storage: Storage;
  backend: PortalBackend;
  conversation(): AssistantTurn[];
  jobs(): JobView[];
  assistantText(text: string): Promise<void>;
  assistantVoice(pcm16: Buffer, sampleRate: number): Promise<void>;
  setHeight(versionId: string, heightMm: number | null): unknown;
  proposeRefine(versionId: string): unknown;
  prepare(versionId: string, settings: PrepareSettings | "auto"): Promise<PrepareSummary>;
  latestPrint(projectId: string): PrepareSummary | null;
  proposePrint(jobId: string): unknown;
  printStatus(): PrintControlStatus;
  pause(): Promise<{ ok: boolean; message: string }>;
  resume(): Promise<{ ok: boolean; message: string }>;
  cancel(): Promise<{ ok: boolean; message: string }>;
  guardian(): GuardianView;
  guardianAnswer(decision: "stop" | "keep"): Promise<{ ok: boolean; message: string }>;
  smartSearch(): SmartSearchState | null;
  /** Gemini's open "Meshy, Claude or open source?" question (answer it via /api/assistant/text). */
  engineChoice?(): EngineChoice | null;
  searchModels(query: string): Promise<SmartSearchState>;
  selectModel(id: string): SmartModelResult;
  importModels(input: { resultId: string; files: { name: string; bytes: Buffer }[] }): Promise<{ projectId: string; versionId: string; parts: string[]; warnings: string[] }>;
  /** Thingiverse API download (only for results marked download "thingiverse-api"). */
  downloadModel(resultId: string): Promise<{ projectId: string; versionId: string; parts: string[]; warnings: string[] }>;
  log(line: string): void;
  /**
   * Phone "Photo to 3D". All optional: when main hasn't wired them the routes answer 503.
   * analyze is free (Gemini looks, recommends Meshy or Claude CAD, cleans the photo for Meshy);
   * only create starts generation or spends credits, and only after the user tapped a choice.
   */
  photoAnalyze?(input: { images: RemotePhoto[]; description: string; owner: string }): Promise<unknown>;
  photoClean?(planId: string): Promise<unknown>;
  photoPreview?(planId: string, index: number): { mime: string; bytes: Uint8Array } | null;
  photoCreate?(input: { planId: string; route: "meshy" | "cad"; useOriginal: boolean; owner: string }): Promise<unknown>;
}

export interface RemotePhoto { name: string; mime: "image/jpeg" | "image/png" | "image/webp"; bytes: Buffer }

/**
 * Phone uploads go through Vercel's /api rewrite, which caps request bodies at about 4.5 MB.
 * The phone resizes to <= 1600 px JPEG; these limits reject anything that slipped through.
 */
export const PHOTO_LIMITS = { maxPhotos: 4, maxPhotoBytes: 2_500_000, maxBodyBytes: 4_400_000, maxDescription: 600 } as const;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Maps MX-P3D codes from the photo pipeline to HTTP statuses the phone can act on. */
function photoStatus(code: string): number {
  if (code === "MX-P3D-080") return 404;
  if (code === "MX-P3D-001" || code === "MX-P3D-002") return 400;
  if (code === "MX-P3D-014") return 422;
  if (code === "MX-P3D-070" || code === "MX-P3D-081" || code === "MX-P3D-092") return 409;
  if (code === "MX-P3D-010" || code === "MX-P3D-020" || code === "MX-P3D-061") return 503;
  if (code === "MX-P3D-015") return 429;
  return 502;
}

function sniffPhoto(b: Buffer): RemotePhoto["mime"] | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

interface Device { name: string; hash: string; createdAt: string; lastSeenAt: string; /** Set when paired by Auth0 sign-in instead of the QR. */ account?: string }
interface PairState { codeHash: string; expiresAt: string; devices: Device[] }

const USER: PortalUser = { sub: "morphix-remote", email: "paired-device@morphix.local", name: "Paired phone", isAdmin: true };
const json = (res: ServerResponse, status: number, body: unknown) => {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(bytes);
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanId = (s: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s)) throw new Error("invalid id");
  return s;
};

export class MorphixRemote {
  private server: Server | null = null;
  private stateFile: string;
  private codeFile: string;
  private state: PairState;
  private currentCode = "";
  private failures = new Map<string, number[]>();
  private auth0: RemoteAuth0;

  constructor(private d: RemoteDeps, private options: { host: string; port: number; allowedOrigins: string[]; auth0?: RemoteAuth0Options }) {
    this.auth0 = new RemoteAuth0(options.auth0);
    this.stateFile = d.storage.path("remote", "devices.json");
    this.codeFile = d.storage.path("remote", "pairing-code.txt");
    this.state = this.load();
  }

  private load(): PairState {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as PairState;
      const savedCode = readFileSync(this.codeFile, "utf8").match(/\d{8}/)?.[0] ?? "";
      if (Array.isArray(parsed.devices) && savedCode && hash(savedCode) === parsed.codeHash && Date.parse(parsed.expiresAt) > Date.now()) {
        this.currentCode = savedCode;
        return { ...parsed, devices: parsed.devices.slice(0, 20) };
      }
    } catch { /* first run */ }
    return this.rotateCode([]);
  }

  private rotateCode(devices = this.state?.devices ?? []): PairState {
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.currentCode = code;
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const next = { codeHash: hash(code), expiresAt, devices };
    this.d.storage.writeAtomic(this.stateFile, JSON.stringify(next, null, 2));
    this.d.storage.writeAtomic(this.codeFile, `Morphix Remote pairing code: ${code}\nExpires: ${expiresAt}\n`);
    try { chmodSync(this.codeFile, 0o600); } catch { /* Windows/dev */ }
    this.d.log(`pairing code written to ${this.codeFile}`);
    return next;
  }

  private save() { this.d.storage.writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2)); }

  async start(): Promise<{ url: string; codeFile: string }> {
    if (this.server) throw new Error("remote server already started");
    this.server = createServer((req, res) => void this.route(req, res).catch((e) => {
      this.d.log(`request failed: ${(e as Error).message}`);
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) json(res, e.status, { error: e.code, message: e.message });
      else json(res, 500, { error: "request_failed", message: (e as Error).message });
    }));
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.options.port, this.options.host, resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return { url: `http://${this.options.host}:${port}`, codeFile: this.codeFile };
  }

  async stop() { if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve())); this.server = null; }

  pairingLink(siteUrl: string): { url: string; expiresAt: string } {
    if (!siteUrl || !/^https:\/\//.test(siteUrl)) throw new Error("MORPHIX_REMOTE_SITE_URL must be an https:// URL");
    return { url: `${siteUrl.replace(/\/$/, "")}/#pair=${encodeURIComponent(this.currentCode)}`, expiresAt: this.state.expiresAt };
  }

  private origin(req: IncomingMessage, res: ServerResponse): boolean {
    const value = String(req.headers.origin ?? "");
    if (value && !this.options.allowedOrigins.includes(value)) { json(res, 403, { error: "origin_not_allowed" }); return false; }
    if (value) {
      res.setHeader("Access-Control-Allow-Origin", value);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    return true;
  }

  private device(req: IncomingMessage): Device | null {
    const m = /^Bearer\s+([A-Za-z0-9_-]{40,})$/.exec(String(req.headers.authorization ?? ""));
    if (!m) return null;
    const h = hash(m[1]);
    const d = this.state.devices.find((x) => x.hash === h) ?? null;
    if (d) { d.lastSeenAt = new Date().toISOString(); this.save(); }
    return d;
  }

  private async body(req: IncomingMessage, max = 1_000_000): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > max) throw new HttpError(413, "too_large", "request is too large"); chunks.push(b); }
    return Buffer.concat(chunks);
  }
  private async input(req: IncomingMessage, max?: number): Promise<Json> {
    const b = await this.body(req, max); if (!b.length) return {};
    const v = JSON.parse(b.toString("utf8")); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object"); return v as Json;
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    if (!this.origin(req, res)) return;
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const u = new URL(req.url ?? "/", "http://remote.local");
    if (req.method === "GET" && u.pathname === "/api/health") { json(res, 200, { ok: true, service: "Morphix Remote" }); return; }
    if (req.method === "POST" && u.pathname === "/api/pair") { await this.pair(req, res); return; }
    if (req.method === "POST" && u.pathname === "/api/pair/auth0/start") { await this.pairAuth0Start(req, res); return; }
    if (req.method === "POST" && u.pathname === "/api/pair/auth0") { await this.pairAuth0(req, res); return; }
    const device = this.device(req);
    if (!device) { json(res, 401, { error: "pairing_required" }); return; }

    if (req.method === "GET" && u.pathname === "/api/state") {
      const [me, projects, actions, printer] = await Promise.all([this.d.backend.me(USER), this.d.backend.listProjects(USER), this.d.backend.pendingActions(USER), this.d.backend.printerStatus(USER)]);
      json(res, 200, { me, projects, actions, printer, print: this.d.printStatus(), guardian: this.d.guardian(), conversation: this.d.conversation(), jobs: this.d.jobs(), smartSearch: this.d.smartSearch(), engineChoice: this.d.engineChoice?.() ?? null, device: { name: device.name } }); return;
    }
    if (req.method === "GET" && u.pathname === "/api/projects") { json(res, 200, { projects: await this.d.backend.listProjects(USER) }); return; }
    let m = /^\/api\/projects\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const p = await this.d.backend.getProject(cleanId(m[1]), USER); json(res, p ? 200 : 404, { project: p }); return; }
    m = /^\/api\/models\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const f = await this.d.backend.modelFile(cleanId(m[1]), USER); if (!f) { json(res, 404, { error: "not_found" }); return; } this.file(res, f.path, f.format === "glb" ? "model/gltf-binary" : "model/stl"); return; }
    m = /^\/api\/thumbnails\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const f = await this.d.backend.thumbnailFile?.(cleanId(m[1]), USER); if (!f) { json(res, 404, { error: "not_found" }); return; } this.file(res, f.path, `image/${f.format === "jpg" ? "jpeg" : f.format}`); return; }
    if (req.method === "GET" && u.pathname === "/api/camera/snapshot") { await this.cameraSnapshot(res); return; }
    if (req.method === "GET" && u.pathname === "/api/camera") { const c = await this.d.backend.cameraStream(USER); if (!c) { json(res, 503, { error: "camera_unavailable" }); return; } res.writeHead(200, { "Content-Type": c.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); c.stream.pipe(res); req.once("close", () => c.stream.destroy()); return; }
    if (req.method === "GET" && u.pathname === "/api/conversation") { json(res, 200, { conversation: this.d.conversation() }); return; }
    if (req.method === "POST" && u.pathname === "/api/models/search") { const b = await this.input(req); json(res, 200, await this.d.searchModels(String(b.query ?? ""))); return; }
    if (req.method === "POST" && u.pathname === "/api/models/download") { const b = await this.input(req); json(res, 201, await this.d.downloadModel(String(b.resultId ?? ""))); return; }
    if (req.method === "POST" && u.pathname === "/api/models/select") { const b = await this.input(req); json(res, 200, { result: this.d.selectModel(String(b.id ?? "")) }); return; }
    if (req.method === "POST" && u.pathname === "/api/models/import") { const b = await this.input(req, 80_000_000); const raw = Array.isArray(b.files) ? b.files : []; if (!raw.length || raw.length > 20) throw new Error("Choose 1 to 20 model files."); const files = raw.map((v:any) => { const bytes=Buffer.from(String(v.data??""),"base64"); if(!bytes.length||bytes.length>20_000_000) throw new Error("Each model file must be under 20 MB."); return {name:String(v.name??"model.stl").slice(0,120),bytes}; }); json(res, 201, await this.d.importModels({ resultId:String(b.resultId??""), files })); return; }
    if (req.method === "POST" && u.pathname === "/api/assistant/text") { const b = await this.input(req); const text = String(b.text ?? "").trim().slice(0, 1000); if (!text) throw new Error("message required"); await this.d.assistantText(text); json(res, 202, { ok: true }); return; }
    if (req.method === "POST" && u.pathname === "/api/assistant/voice") { const b = await this.input(req, 9_000_000); const pcm = Buffer.from(String(b.pcm ?? ""), "base64"); const rate = Number(b.sampleRate); if (rate !== 16000 || !pcm.length || pcm.length > 7_680_000) throw new Error("expected up to two minutes of 16 kHz PCM16"); await this.d.assistantVoice(pcm, rate); json(res, 202, { ok: true }); return; }
    if (req.method === "POST" && u.pathname === "/api/requests/text") { const b = await this.input(req); json(res, 202, await this.d.backend.createTextRequest(String(b.prompt ?? "").trim().slice(0, 1000), USER)); return; }
    if (req.method === "POST" && u.pathname === "/api/requests/photo") { await this.photo(req, res); return; }
    if (req.method === "POST" && u.pathname === "/api/actions/confirm") { const b = await this.input(req); json(res, 200, await this.d.backend.confirmAction(cleanId(String(b.id ?? "")), USER)); return; }
    if (req.method === "POST" && u.pathname === "/api/actions/cancel") { const b = await this.input(req); json(res, 200, await this.d.backend.cancelAction(cleanId(String(b.id ?? "")), USER)); return; }
    m = /^\/api\/versions\/([^/]+)\/(height|refine|prepare)$/.exec(u.pathname);
    if (req.method === "POST" && m) { const id = cleanId(m[1]), b = await this.input(req); if (m[2] === "height") json(res, 200, { version: this.d.setHeight(id, b.heightMm == null ? null : Number(b.heightMm)) }); else if (m[2] === "refine") json(res, 200, { action: this.d.proposeRefine(id) }); else json(res, 200, { summary: await this.d.prepare(id, b.settings === "auto" || !b.settings ? "auto" : b.settings as unknown as PrepareSettings) }); return; }
    m = /^\/api\/projects\/([^/]+)\/latest-print$/.exec(u.pathname);
    if (req.method === "GET" && m) { json(res, 200, { summary: this.d.latestPrint(cleanId(m[1])) }); return; }
    if (req.method === "POST" && u.pathname === "/api/print/request") { const b = await this.input(req); json(res, 200, { action: this.d.proposePrint(cleanId(String(b.jobId ?? ""))) }); return; }
    if (req.method === "POST" && u.pathname === "/api/print/control") { const b = await this.input(req); const cmd = String(b.command); const result = cmd === "pause" ? await this.d.pause() : cmd === "resume" ? await this.d.resume() : cmd === "cancel" ? await this.d.cancel() : null; if (!result) { json(res, 400, { error: "invalid_command" }); return; } json(res, result.ok ? 200 : 409, result); return; }
    if (req.method === "POST" && u.pathname === "/api/printer/command") { const b = await this.input(req); json(res, 200, await this.d.backend.printerCommand(b as unknown as PrinterCommand, USER)); return; }
    if (req.method === "POST" && u.pathname === "/api/guardian/answer") { const b = await this.input(req); const decision = b.decision === "stop" ? "stop" : b.decision === "keep" ? "keep" : null; if (!decision) throw new Error("invalid decision"); json(res, 200, await this.d.guardianAnswer(decision)); return; }
    if (u.pathname.startsWith("/api/photo/")) { await this.photoRoute(req, res, u); return; }
    if (req.method === "DELETE" && u.pathname === "/api/device") { this.state.devices = this.state.devices.filter((x) => x.hash !== device.hash); this.save(); json(res, 200, { ok: true }); return; }
    json(res, 404, { error: "not_found" });
  }

  private photoBusy = 0;

  /** Phone "Photo to 3D": /api/photo/analyze, /api/photo/plans/:id/clean|preview/:n, /api/photo/create. */
  private async photoRoute(req: IncomingMessage, res: ServerResponse, u: URL) {
    const d = this.d;
    if (!d.photoAnalyze || !d.photoCreate) { json(res, 503, { error: "photo_unavailable", message: "Photo to 3D is not set up on this Morphix yet." }); return; }
    try {
      if (req.method === "POST" && u.pathname === "/api/photo/analyze") {
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > PHOTO_LIMITS.maxBodyBytes) throw new HttpError(413, "too_large", "These photos are too big to send. Use fewer photos or smaller ones.");
        if (this.photoBusy >= 2) throw new HttpError(429, "busy", "Morphix is still looking at your last photos. Try again in a moment.");
        this.photoBusy++;
        try {
          const b = await this.input(req, PHOTO_LIMITS.maxBodyBytes);
          const description = String(b.description ?? "").trim().slice(0, PHOTO_LIMITS.maxDescription);
          if (!description) throw new HttpError(400, "description_required", "Say what to make from the photo.");
          const raw = Array.isArray(b.images) ? b.images : [];
          if (!raw.length || raw.length > PHOTO_LIMITS.maxPhotos) throw new HttpError(400, "photo_count", `Add 1 to ${PHOTO_LIMITS.maxPhotos} photos.`);
          const images = raw.map((v, i): RemotePhoto => {
            const x = (v ?? {}) as Json, bytes = Buffer.from(String(x.data ?? ""), "base64");
            if (!bytes.length) throw new HttpError(400, "photo_empty", `Photo ${i + 1} is empty.`);
            if (bytes.length > PHOTO_LIMITS.maxPhotoBytes) throw new HttpError(413, "too_large", `Photo ${i + 1} is too big (max ${(PHOTO_LIMITS.maxPhotoBytes / 1e6).toFixed(1)} MB).`);
            const mime = sniffPhoto(bytes);
            if (!mime) throw new HttpError(415, "photo_type", `Photo ${i + 1} must be a JPEG, PNG or WebP image.`);
            return { name: String(x.name ?? `photo-${i + 1}.jpg`).replace(/[^\w. -]/g, "").slice(0, 80) || `photo-${i + 1}.jpg`, mime, bytes };
          });
          d.log(`photo analyze: ${images.length} photo(s), ${images.reduce((n, x) => n + x.bytes.length, 0)} bytes`);
          json(res, 200, { plan: await d.photoAnalyze({ images, description, owner: USER.sub }) });
        } finally { this.photoBusy--; }
        return;
      }
      if (req.method === "POST" && u.pathname === "/api/photo/create") {
        const b = await this.input(req);
        const route = b.route === "meshy" ? "meshy" : b.route === "cad" ? "cad" : null;
        if (!route) throw new HttpError(400, "invalid_route", "Choose Meshy or Claude CAD.");
        json(res, 202, await d.photoCreate({ planId: cleanId(String(b.planId ?? "")), route, useOriginal: b.useOriginal === true, owner: USER.sub }));
        return;
      }
      let m = /^\/api\/photo\/plans\/([^/]+)\/clean$/.exec(u.pathname);
      if (req.method === "POST" && m) {
        if (!d.photoClean) throw new HttpError(503, "photo_unavailable", "Photo cleanup is not set up.");
        json(res, 200, { plan: await d.photoClean(cleanId(m[1])) });
        return;
      }
      m = /^\/api\/photo\/plans\/([^/]+)\/preview\/(\d)$/.exec(u.pathname);
      if (req.method === "GET" && m) {
        const img = d.photoPreview?.(cleanId(m[1]), Number(m[2]));
        if (!img) { json(res, 404, { error: "not_found" }); return; }
        const bytes = Buffer.from(img.bytes.buffer, img.bytes.byteOffset, img.bytes.byteLength);
        res.writeHead(200, { "Content-Type": img.mime, "Content-Length": bytes.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        res.end(bytes);
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const code = String((e as { code?: unknown }).code ?? "");
      if (/^MX-P3D-\d{3}$/.test(code)) { json(res, photoStatus(code), { error: code, message: (e as Error).message }); return; }
      if ((e as Error).message === "invalid id") throw new HttpError(400, "invalid_id", "invalid id");
      throw e;
    }
  }

  private file(res: ServerResponse, path: string, contentType: string) {
    if (!existsSync(path)) { json(res, 404, { error: "not_found" }); return; }
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); createReadStream(path).pipe(res);
  }

  private async cameraSnapshot(res: ServerResponse) {
    const camera = await this.d.backend.cameraStream(USER);
    if (!camera) { json(res, 503, { error: "camera_unavailable" }); return; }
    let data = Buffer.alloc(0), frame: Buffer | null = null;
    const timer = setTimeout(() => camera.stream.destroy(new Error("camera snapshot timeout")), 8_000);
    try {
      for await (const chunk of camera.stream) {
        data = Buffer.concat([data, Buffer.from(chunk)]);
        const start = data.indexOf(Buffer.from([0xff, 0xd8]));
        const end = start >= 0 ? data.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1;
        if (start >= 0 && end > start) { frame = data.subarray(start, end + 2); break; }
        if (data.length > 4_000_000) data = data.subarray(-1_000_000);
      }
    } catch { /* reported below */ }
    finally { clearTimeout(timer); camera.stream.destroy(); }
    if (!frame) { json(res, 503, { error: "camera_frame_unavailable" }); return; }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": frame.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(frame);
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? "unknown", now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((x) => now - x < 10 * 60_000);
    if (recent.length >= 8) { json(res, 429, { error: "too_many_attempts" }); return; }
    const b = await this.input(req), code = String(b.code ?? "").replace(/\D/g, ""), name = String(b.name ?? "Phone").trim().slice(0, 40) || "Phone";
    if (Date.parse(this.state.expiresAt) < now || hash(code) !== this.state.codeHash) { recent.push(now); this.failures.set(ip, recent); json(res, 401, { error: "invalid_pairing_code" }); return; }
    const token = randomBytes(32).toString("base64url"), at = new Date().toISOString();
    this.state.devices.push({ name, hash: hash(token), createdAt: at, lastSeenAt: at });
    this.state = this.rotateCode(this.state.devices.slice(-20));
    json(res, 200, { token, device: { name }, pairedAt: at });
  }

  private tooManyFailures(key: string, now: number): boolean {
    const recent = (this.failures.get(key) ?? []).filter((x) => now - x < 10 * 60_000);
    this.failures.set(key, recent);
    return recent.length >= 8;
  }

  /** Phone "Sign in with Auth0", step 1: a one-time nonce for Auth0's /authorize. */
  private async pairAuth0Start(req: IncomingMessage, res: ServerResponse) {
    const key = `auth0:${req.socket.remoteAddress ?? "unknown"}`;
    if (this.tooManyFailures(key, Date.now())) { json(res, 429, { error: "too_many_attempts" }); return; }
    try { json(res, 200, this.auth0.start()); }
    catch (e) { if (!(e instanceof Auth0Refusal)) throw e; json(res, e.status, e.body()); }
  }

  /** Step 2: a verified Auth0 ID token from an allowed, verified email becomes a normal device token. */
  private async pairAuth0(req: IncomingMessage, res: ServerResponse) {
    const key = `auth0:${req.socket.remoteAddress ?? "unknown"}`, now = Date.now();
    if (this.tooManyFailures(key, now)) { json(res, 429, { error: "too_many_attempts" }); return; }
    const b = await this.input(req, 64_000), name = String(b.name ?? "Phone").trim().slice(0, 40) || "Phone";
    let account: { email: string };
    try { account = await this.auth0.verify(b.idToken); }
    catch (e) {
      if (!(e instanceof Auth0Refusal)) throw e;
      this.failures.get(key)!.push(now);
      this.d.log(`Auth0 phone sign-in refused: ${e.code} (${e.reason}${e.email ? `: ${e.email}` : ""})`);
      json(res, e.status, e.body());
      return;
    }
    const token = randomBytes(32).toString("base64url"), at = new Date().toISOString();
    this.state.devices = [...this.state.devices, { name, hash: hash(token), createdAt: at, lastSeenAt: at, account: account.email }].slice(-20);
    this.save();
    this.d.log(`phone paired by Auth0 sign-in: ${account.email}`);
    json(res, 200, { token, device: { name }, pairedAt: at });
  }

  private async photo(req: IncomingMessage, res: ServerResponse) {
    const b = await this.input(req, 48_000_000); const raw = Array.isArray(b.images) ? b.images : [];
    if (!raw.length || raw.length > 6) throw new Error("add 1 to 6 images");
    const images = raw.map((v, i) => { const x = v as Json, bytes = Buffer.from(String(x.data ?? ""), "base64"); if (!bytes.length || bytes.length > 12_000_000) throw new Error("each image must be under 12 MB"); const mime = sniffImage(bytes); if (!mime) throw new Error("use JPEG, PNG, WebP or HEIC images"); return { name: String(x.name ?? `photo-${i + 1}`).slice(0, 100), mime, bytes }; });
    const accepted = await this.d.backend.createPhotoRequest({ images, description: String(b.description ?? "").trim().slice(0, 1000), measurements: [], referenceObject: "none", user: USER });
    json(res, 202, accepted);
  }
}

