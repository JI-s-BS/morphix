// HTTP Digest authentication (RFC 7616, with RFC 2069 fallback when the server sends no qop), as used by
// PrusaLink (user "maker" + the password from the printer's menu). MD5, MD5-sess, SHA-256, SHA-256-sess.
// Built from the RFCs with node:crypto; checked against the RFC 2617 / 7616 example vectors in the tests,
// not against a real printer. The password is only ever hashed, never logged or put into a message.
import { createHash, randomBytes } from "node:crypto";
import type { Authorizer, Reply } from "./common";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
  stale?: boolean;
}

/** Parses `Digest realm="x", nonce="y", qop="auth,auth-int"`; undefined if it is not a Digest challenge. */
export function parseDigestChallenge(header: string | null): DigestChallenge | undefined {
  if (!header) return undefined;
  const m = /^\s*Digest\s+(.*)$/is.exec(header);
  if (!m) return undefined;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[1]))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : p[3];
  if (!params.nonce) return undefined;
  return {
    realm: params.realm ?? "",
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm ?? "MD5",
    stale: params.stale?.toLowerCase() === "true",
  };
}

function hasher(algorithm: string): (s: string) => string {
  const alg = algorithm.toUpperCase().replace(/-SESS$/, "");
  const name = alg === "SHA-256" ? "sha256" : alg === "SHA-512-256" ? "sha512-256" : "md5";
  return (s) => createHash(name).update(s, "utf8").digest("hex");
}

export interface DigestInput {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  /** "00000001" … */
  nc: string;
  cnonce: string;
}

/** The `response` value (RFC 7616 §3.4.1). */
export function digestResponse(i: DigestInput): string {
  const H = hasher(i.challenge.algorithm);
  let ha1 = H(`${i.username}:${i.challenge.realm}:${i.password}`);
  if (/-sess$/i.test(i.challenge.algorithm)) ha1 = H(`${ha1}:${i.challenge.nonce}:${i.cnonce}`);
  const ha2 = H(`${i.method}:${i.uri}`);
  const qop = pickQop(i.challenge.qop);
  return qop ? H(`${ha1}:${i.challenge.nonce}:${i.nc}:${i.cnonce}:${qop}:${ha2}`) : H(`${ha1}:${i.challenge.nonce}:${ha2}`);
}

function pickQop(qop?: string): "auth" | undefined {
  if (!qop) return undefined;
  return qop.split(",").map((s) => s.trim().toLowerCase()).includes("auth") ? "auth" : undefined;
}

const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

/** The full `Authorization: Digest ...` header value. */
export function digestHeader(i: DigestInput): string {
  const qop = pickQop(i.challenge.qop);
  const parts = [
    `username=${quote(i.username)}`,
    `realm=${quote(i.challenge.realm)}`,
    `nonce=${quote(i.challenge.nonce)}`,
    `uri=${quote(i.uri)}`,
    `algorithm=${i.challenge.algorithm}`,
    `response=${quote(digestResponse(i))}`,
  ];
  if (i.challenge.opaque !== undefined) parts.push(`opaque=${quote(i.challenge.opaque)}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${i.nc}`, `cnonce=${quote(i.cnonce)}`);
  return `Digest ${parts.join(", ")}`;
}

/** Keeps the last challenge and answers every request with it; a 401 with a new challenge triggers one retry. */
export class DigestAuth implements Authorizer {
  private challengeData?: DigestChallenge;
  private count = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  get ready(): boolean {
    return !!this.challengeData;
  }

  headers(method: string, uri: string): Record<string, string> {
    if (!this.challengeData) return {};
    this.count++;
    return {
      Authorization: digestHeader({
        username: this.username,
        password: this.password,
        method,
        uri,
        challenge: this.challengeData,
        nc: this.count.toString(16).padStart(8, "0"),
        cnonce: randomBytes(8).toString("hex"),
      }),
    };
  }

  challenge(reply: Reply): boolean {
    const c = parseDigestChallenge(reply.headers.get("www-authenticate"));
    if (!c) return false;
    // Same nonce, not stale, and we already answered it: the password is wrong; don't retry.
    const retry = !this.challengeData || c.stale === true || c.nonce !== this.challengeData.nonce;
    this.challengeData = c;
    this.count = 0;
    return retry;
  }
}
