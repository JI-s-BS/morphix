// Print approval tokens. A PrintAuthorization records that a person approved
// one specific file for one specific job, by touch or voice, a moment ago.
// Tokens are only valid if this process issued them (looked up by a random id),
// expire quickly, and are single-use for anything that starts or resumes a print.
import { randomUUID } from "node:crypto";
import { assertStoredFileName } from "./names";

export type ApprovalSource = "touch" | "voice";

export interface PrintAuthorizationRequest {
  jobId: string;
  fileName: string;
  approvedBy: ApprovalSource;
  /** Lifetime in ms. Default 120 000, capped by the authorizer (default 600 000). */
  expiresInMs?: number;
}

export interface PrintAuthorization {
  readonly id: string;
  readonly jobId: string;
  readonly fileName: string;
  readonly approvedBy: ApprovalSource;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type AuthorizationFailure = "missing" | "unknown" | "tampered" | "expired" | "reused" | "job-mismatch" | "file-mismatch";

export class PrintAuthorizationError extends Error {
  constructor(public readonly code: AuthorizationFailure, message: string) {
    super(message);
  }
}

export const DEFAULT_AUTH_TTL_MS = 120_000;

interface Record_ {
  token: PrintAuthorization;
  used: boolean;
}

export class PrintAuthorizer {
  private issued = new Map<string, Record_>();
  private now: () => number;
  private maxTtlMs: number;

  constructor(opts: { now?: () => number; maxExpiresInMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxTtlMs = opts.maxExpiresInMs ?? 600_000;
  }

  authorize(req: PrintAuthorizationRequest): PrintAuthorization {
    if (!req || typeof req.jobId !== "string" || !req.jobId.trim()) throw new TypeError("authorizePrint: jobId is required");
    if (req.approvedBy !== "touch" && req.approvedBy !== "voice") throw new TypeError('authorizePrint: approvedBy must be "touch" or "voice"');
    assertStoredFileName(req.fileName, { allowPlainGcode: true });
    const ttl = req.expiresInMs ?? DEFAULT_AUTH_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError("authorizePrint: expiresInMs must be positive");
    this.purge();
    const issuedAt = this.now();
    const token: PrintAuthorization = Object.freeze({
      id: randomUUID(),
      jobId: req.jobId,
      fileName: req.fileName,
      approvedBy: req.approvedBy,
      issuedAt,
      expiresAt: issuedAt + Math.min(ttl, this.maxTtlMs),
    });
    this.issued.set(token.id, { token, used: false });
    return token;
  }

  /**
   * Throws PrintAuthorizationError unless `token` was issued here, is unexpired,
   * unused, and bound to exactly this job and file. With `consume`, marks it used.
   */
  verify(token: PrintAuthorization | undefined | null, expect: { jobId: string; fileName: string }, consume: boolean): PrintAuthorization {
    if (!token || typeof token !== "object" || typeof token.id !== "string") {
      throw new PrintAuthorizationError("missing", "a print authorization is required");
    }
    const rec = this.issued.get(token.id);
    if (!rec) throw new PrintAuthorizationError("unknown", "print authorization was not issued by this app (or has been purged)");
    const t = rec.token;
    if (
      token.jobId !== t.jobId ||
      token.fileName !== t.fileName ||
      token.approvedBy !== t.approvedBy ||
      token.issuedAt !== t.issuedAt ||
      token.expiresAt !== t.expiresAt
    ) {
      throw new PrintAuthorizationError("tampered", "print authorization does not match what was issued");
    }
    if (rec.used) throw new PrintAuthorizationError("reused", "print authorization has already been used");
    if (this.now() >= t.expiresAt) throw new PrintAuthorizationError("expired", "print authorization has expired; ask the user again");
    if (t.jobId !== expect.jobId) throw new PrintAuthorizationError("job-mismatch", `authorization is for job ${t.jobId}, not ${expect.jobId}`);
    if (t.fileName !== expect.fileName) {
      throw new PrintAuthorizationError("file-mismatch", `authorization is for ${t.fileName}, not ${expect.fileName}`);
    }
    if (consume) rec.used = true;
    return t;
  }

  /** Invalidates a token (e.g. the user changed their mind). */
  revoke(token: PrintAuthorization): void {
    const rec = this.issued.get(token.id);
    if (rec) rec.used = true;
  }

  private purge(): void {
    const now = this.now();
    // Keep used/expired records a while so a replay reports "reused"/"expired" rather than "unknown".
    for (const [id, rec] of this.issued) if (now > rec.token.expiresAt + this.maxTtlMs) this.issued.delete(id);
  }
}

/** Process-wide authorizer used by authorizePrint() and, by default, every QD330Controller. */
export const defaultPrintAuthorizer = new PrintAuthorizer();

export function authorizePrint(req: PrintAuthorizationRequest): PrintAuthorization {
  return defaultPrintAuthorizer.authorize(req);
}
