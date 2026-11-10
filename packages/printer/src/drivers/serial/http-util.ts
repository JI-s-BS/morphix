// Small HTTP helpers for the Ultimaker and Snapmaker drivers: a timeout on every call, errors mapped
// to DriverError with a plain hint, and HTTP Digest auth (RFC 7616, MD5 + qop=auth) for Ultimaker.
// URLs are never put in error messages or logs (Snapmaker carries its token in the query string).
import { createHash, randomBytes } from "node:crypto";
import { DriverError } from "../types";

export type Fetch = typeof fetch;

export interface HttpTarget {
  fetch: Fetch;
  timeoutMs: number;
  /** "Ultimaker" / "Snapmaker": used in messages. */
  what: string;
}

/** fetch with a timeout; network failures become DriverError("unreachable" | "timeout"). */
export async function request(t: HttpTarget, url: string, init: RequestInit = {}): Promise<Response> {
  const signal = AbortSignal.timeout(t.timeoutMs);
  try {
    return await t.fetch(url, { ...init, signal });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError" || signal.aborted) {
      throw new DriverError("timeout", `The ${t.what} did not answer within ${Math.round(t.timeoutMs / 1000)} s`,
        `Check that the ${t.what} is switched on and connected to the same network as Morphix.`);
    }
    throw new DriverError("unreachable", `Cannot reach the ${t.what}`,
      `Check the IP address on the printer's screen, and that the printer and Morphix are on the same network.`);
  }
}

/** Throws a DriverError for a non-2xx response. */
export async function expectOk(t: HttpTarget, res: Response, action: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  const detail = /^[\x20-\x7e]{1,120}$/.test(body.trim()) ? `: ${body.trim()}` : "";
  if (res.status === 401 || res.status === 403) {
    throw new DriverError("auth", `The ${t.what} refused ${action} (not authorized)`,
      "Pair Morphix with the printer again and confirm on the printer's screen.");
  }
  if (res.status === 409) {
    throw new DriverError("busy", `The ${t.what} is busy and refused ${action}${detail}`, "Wait until the printer is idle, then try again.");
  }
  throw new DriverError("rejected", `The ${t.what} refused ${action} (HTTP ${res.status})${detail}`,
    "Check the printer's screen for a message, then try again.");
}

export async function readJson<T>(t: HttpTarget, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new DriverError("protocol", `The ${t.what} sent an answer Morphix does not understand`,
      "Check that the address belongs to this kind of printer and that its firmware is up to date.");
  }
}

// -- Digest auth --------------------------------------------------------------------------------

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

interface Challenge { realm: string; nonce: string; opaque?: string; qop?: string; algorithm?: string }

export function parseDigestChallenge(header: string | null): Challenge | undefined {
  if (!header || !/^\s*digest\s/i.test(header)) return undefined;
  const out: Record<string, string> = {};
  for (const m of header.replace(/^\s*digest\s+/i, "").matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  if (!out.nonce) return undefined;
  return { realm: out.realm ?? "", nonce: out.nonce, opaque: out.opaque, qop: out.qop, algorithm: out.algorithm };
}

export function digestHeader(c: Challenge, user: string, pass: string, method: string, uri: string, nc: number, cnonce: string): string {
  const ha1 = md5(`${user}:${c.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const useQop = c.qop?.split(",").map((s) => s.trim()).includes("auth");
  const ncs = nc.toString(16).padStart(8, "0");
  const response = useQop ? md5(`${ha1}:${c.nonce}:${ncs}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`, "algorithm=MD5"];
  if (useQop) parts.push("qop=auth", `nc=${ncs}`, `cnonce="${cnonce}"`);
  if (c.opaque !== undefined) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

/** Keeps the last challenge so a large upload is sent once, not once to get a 401 and again. */
export class DigestSession {
  private challenge?: Challenge;
  private nc = 0;
  constructor(private user: string, private pass: string) {}

  async fetch(t: HttpTarget, url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const uri = new URL(url).pathname + new URL(url).search;
    let res!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = new Headers(init.headers);
      const sent = this.challenge;
      if (sent) {
        this.nc++;
        headers.set("Authorization", digestHeader(sent, this.user, this.pass, method, uri, this.nc, randomBytes(8).toString("hex")));
      }
      res = await request(t, url, { ...init, headers });
      if (res.status !== 401) return res;
      const next = parseDigestChallenge(res.headers.get("www-authenticate"));
      // Same nonce back for a signed request: the credentials are wrong; a new nonce: try once more.
      if (!next || (sent && next.nonce === sent.nonce)) return res;
      await res.body?.cancel().catch(() => {});
      this.challenge = next;
      this.nc = 0;
    }
    return res;
  }
}

/** "192.168.1.20", "printer.local", "http://192.168.1.20/" → "http://192.168.1.20:<port>". Throws for anything else. */
export function baseUrl(host: unknown, port?: number): string {
  const h = String(host ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!h) throw new DriverError("rejected", "No printer address entered", "Enter the IP address shown on the printer's screen.");
  if (!/^(?:\[[0-9a-f:.]+\]|[\w.-]+)(?::\d{1,5})?$/i.test(h)) {
    throw new DriverError("rejected", "That is not a valid printer address", "Enter just the IP address, like 192.168.1.20.");
  }
  return /:\d+$/.test(h) || port === undefined ? `http://${h}` : `http://${h}:${port}`;
}

/** A file stashed by upload() until start(): these printers take the file and start in one request. */
export interface Stash { name: string; data: Buffer }
