// Morphix Cloud link (private preview, github.com/JI-s-BS/Morfix-sever). Pairing works like a TV:
// Morphix asks the cloud for a code, shows it with a QR code of the cloud's /pair page, and waits
// until the owner confirms it there. Afterwards it reports a small status every minute. Morphix only
// makes outgoing HTTPS requests; nothing is opened on the router. The device secret is kept in
// <data>/cloud.json (mode 0600) and is never logged or sent to the browser.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import type { CloudStatus } from "@morphix/shared";

export const DEFAULT_CLOUD_URL = "https://morfix-sever.vercel.app";

/** What the cloud may see: no file contents, keys, addresses or camera. */
export interface CloudReport {
  online: boolean;
  state?: string;
  printer?: string;
  file?: string;
  progress?: number;
  nozzleC?: number;
  bedC?: number;
  version?: string;
}

export interface CloudOptions {
  dataDir: string;
  /** Base URL of the cloud site (MORPHIX_CLOUD_URL). */
  url: string;
  version: string;
  /** Name shown on the dashboard (the active printer's name, else "Morphix"). */
  name: () => string;
  report: () => CloudReport;
  onChange?: (s: CloudStatus) => void;
  log?: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  fetch?: typeof fetch;
  heartbeatMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

interface Saved { url: string; deviceId: string; secret: string; name?: string; pairedAt: string }
interface Pending { deviceId: string; secret: string; code: string; pairUrl: string; expiresAt: string; qrDataUrl: string | null }

export class CloudLink {
  private saved: Saved | null = null;
  private pending: Pending | null = null;
  private lastError: string | null = null;
  private lastReportAt: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly doFetch: typeof fetch;

  constructor(private o: CloudOptions) {
    this.file = join(o.dataDir, "cloud.json");
    this.doFetch = o.fetch ?? fetch;
    this.saved = this.load();
  }

  private get base(): string {
    return this.o.url.replace(/\/$/, "");
  }

  private load(): Saved | null {
    try {
      if (!existsSync(this.file)) return null;
      const s = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      return s.deviceId && s.secret && s.url === this.base ? s : null;
    } catch {
      return null;
    }
  }

  private save(s: Saved | null): void {
    this.saved = s;
    if (!s) {
      rmSync(this.file, { force: true });
      return;
    }
    writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  status(): CloudStatus {
    if (this.saved) return { state: "paired", url: this.base, name: this.saved.name ?? null, pairedAt: this.saved.pairedAt, lastReportAt: this.lastReportAt, error: this.lastError };
    if (this.pending) {
      return { state: "pairing", url: this.base, code: this.pending.code, pairUrl: this.pending.pairUrl, qrDataUrl: this.pending.qrDataUrl, expiresAt: this.pending.expiresAt, error: this.lastError };
    }
    return { state: "off", url: this.base, error: this.lastError };
  }

  private changed(): void {
    this.o.onChange?.(this.status());
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, auth?: { deviceId: string; secret: string }): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth.deviceId}.${auth.secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
    });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, json };
  }

  private plainError(e: unknown, what: string): string {
    const m = (e as Error)?.name === "TimeoutError" ? "the cloud didn't answer in time" : (e as Error)?.message ?? String(e);
    return `${what}: ${m}. Check this machine is online, then try again.`;
  }

  /** Starts pairing: a code and QR code to show. */
  async pair(): Promise<CloudStatus> {
    this.stopPolling();
    this.lastError = null;
    try {
      const { status, json } = await this.call("POST", "/api/devices/pairing", { name: this.o.name(), version: this.o.version });
      if (status !== 201) {
        const err = json.error as { message?: string; hint?: string } | undefined;
        throw new Error([err?.message ?? `the cloud answered ${status}`, err?.hint].filter(Boolean).join(" "));
      }
      const p = json as unknown as Omit<Pending, "qrDataUrl">;
      if (!p.deviceId || !p.secret || !p.code || !p.pairUrl) throw new Error("the cloud sent an incomplete answer");
      const qrDataUrl = await QRCode.toDataURL(p.pairUrl, { width: 260, margin: 1 }).catch(() => null);
      this.pending = { deviceId: p.deviceId, secret: p.secret, code: p.code, pairUrl: p.pairUrl, expiresAt: p.expiresAt, qrDataUrl };
      this.o.log?.("info", "cloud pairing started", { url: this.base, expiresAt: p.expiresAt });
      this.startPolling();
    } catch (e) {
      this.pending = null;
      this.lastError = this.plainError(e, "Couldn't start pairing");
      this.o.log?.("warn", "cloud pairing failed", { error: (e as Error).message });
    }
    this.changed();
    return this.status();
  }

  private startPolling(): void {
    this.stopPolling();
    const tick = async () => {
      const p = this.pending;
      if (!p) return;
      if (Date.parse(p.expiresAt) < Date.now()) {
        this.pending = null;
        this.lastError = "The pairing code expired. Start pairing again.";
        this.changed();
        return;
      }
      try {
        const { status, json } = await this.call("GET", "/api/devices/pairing", undefined, p);
        if (status === 200 && json.status === "paired") {
          this.pending = null;
          this.save({ url: this.base, deviceId: p.deviceId, secret: p.secret, name: typeof json.name === "string" ? json.name : undefined, pairedAt: new Date().toISOString() });
          this.o.log?.("info", "paired with Morphix Cloud", { url: this.base });
          this.changed();
          this.startHeartbeat();
          return;
        }
        if (status === 200 && (json.status === "expired" || json.status === "revoked")) {
          this.pending = null;
          this.lastError = json.status === "expired" ? "The pairing code expired. Start pairing again." : "Pairing was cancelled.";
          this.changed();
          return;
        }
      } catch {
        /* keep waiting; the network may come back */
      }
      this.pollTimer = setTimeout(tick, this.o.pollMs ?? 3_000);
    };
    this.pollTimer = setTimeout(tick, this.o.pollMs ?? 3_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Sends one status report now. */
  async heartbeat(): Promise<void> {
    const s = this.saved;
    if (!s) return;
    try {
      const { status, json } = await this.call("POST", "/api/devices/heartbeat", { ...this.o.report(), version: this.o.version }, s);
      if (status === 200) {
        this.lastReportAt = new Date().toISOString();
        if (this.lastError) {
          this.lastError = null;
          this.changed();
        }
        return;
      }
      if (status === 410 || status === 401) {
        // Removed on the dashboard (or the cloud forgot it): forget the link here too.
        this.o.log?.("info", "Morphix Cloud link removed", { status });
        this.stopHeartbeat();
        this.save(null);
        this.lastError = "This machine was removed from Morphix Cloud. Pair it again to reconnect.";
        this.changed();
        return;
      }
      const err = json.error as { message?: string } | undefined;
      this.lastError = `Status report failed: ${err?.message ?? `the cloud answered ${status}`}.`;
      this.changed();
    } catch (e) {
      const msg = this.plainError(e, "Status report failed");
      if (msg !== this.lastError) {
        this.lastError = msg;
        this.changed();
      }
    }
  }

  /** Reports at once, then every heartbeatMs (default 60 s). */
  startHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.saved) return;
    void this.heartbeat();
    this.beatTimer = setInterval(() => void this.heartbeat(), this.o.heartbeatMs ?? 60_000);
    this.beatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
  }

  /** Cancels pairing or forgets the link on this machine (remove it on the dashboard too). */
  unpair(): CloudStatus {
    this.stopPolling();
    this.stopHeartbeat();
    this.pending = null;
    this.lastError = null;
    if (this.saved) this.o.log?.("info", "Morphix Cloud link forgotten on this machine");
    this.save(null);
    this.changed();
    return this.status();
  }

  stop(): void {
    this.stopPolling();
    this.stopHeartbeat();
  }
}
