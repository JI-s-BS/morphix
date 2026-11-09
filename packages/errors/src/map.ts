// toMorphixError: turns anything thrown (Node errno errors, fetch failures, HTTP
// errors from Meshy/Gemini/Auth0, slicer results, printer-controller errors, plain
// messages) into a MorphixError with the most specific registered code.
import { isMorphixError, isSerializedMorphixError, MorphixError, type ErrorContext } from "./error";
import { ERROR_CODE_PATTERN, isKnownErrorCode, type ErrorCode } from "./registry";

/** Which external thing the failing operation talked to. Picks between e.g. PRINT-001 and NET-001. */
export type ErrorService = "printer" | "meshy" | "gemini" | "gemini-live" | "auth0" | "camera" | "slicer" | "openscad" | "storage" | "network" | "portal";

export interface ToMorphixErrorOptions {
  /** Defaults from the fallback code's area (PRINT -> printer, GEN -> meshy, …). */
  service?: ErrorService;
  context?: ErrorContext;
}

const AREA_SERVICE: Record<string, ErrorService> = {
  PRINT: "printer",
  GEN: "meshy",
  VOICE: "gemini-live",
  GUARD: "camera",
  SLICE: "slicer",
  STORE: "storage",
  NET: "network",
  AUTH: "auth0",
  PORTAL: "portal",
};

type Rule = { code: ErrorCode; retryable?: boolean } | null;

/**
 * Maps any thrown value to a MorphixError. MorphixErrors (and their JSON form) pass
 * through unchanged (extra context is merged). When nothing specific matches, the
 * result uses `fallbackCode` (default MX-SYS-001) and keeps the original as `cause`.
 */
export function toMorphixError(err: unknown, fallbackCode: ErrorCode | string = "MX-SYS-001", opts: ToMorphixErrorOptions = {}): MorphixError {
  if (isMorphixError(err)) return opts.context ? err.withContext(opts.context) : err;
  if (isSerializedMorphixError(err)) {
    const e = MorphixError.fromJSON(err);
    return opts.context ? e.withContext(opts.context) : e;
  }
  const fallback = ERROR_CODE_PATTERN.test(fallbackCode) ? fallbackCode : "MX-SYS-001";
  const service = opts.service ?? AREA_SERVICE[ERROR_CODE_PATTERN.exec(fallback)?.[1] ?? ""];
  const info = inspect(err);
  const rule = classify(info, service);
  const code = rule?.code ?? fallback;
  const context: ErrorContext = { ...(service ? { service } : {}), ...info.extra, ...opts.context };
  return new MorphixError(code, {
    message: info.message || undefined,
    cause: err instanceof Error ? err : err === undefined ? undefined : err,
    context,
    retryable: rule?.retryable,
  });
}

/** Runs `fn`, converting anything it throws with toMorphixError. */
export async function withErrorCode<T>(fallbackCode: ErrorCode | string, fn: () => Promise<T>, opts: ToMorphixErrorOptions = {}): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toMorphixError(e, fallbackCode, opts);
  }
}

// ------------------------------------------------------------------ internals

interface Inspected {
  name: string;
  message: string;
  /** errno-style codes found on the error or its causes (ECONNREFUSED, ENOSPC, …). */
  errnos: string[];
  status: number | null;
  /** OAuth/Auth0 `error` field (access_denied, login_required, …). */
  oauth: string | null;
  /** `reason` of a { ok: false, reason } result object (slicer, guardian, …). */
  reason: string | null;
  /** A registered MX code found on the value (e.g. { code: "MX-P3D-004" }). */
  mxCode: string | null;
  extra: ErrorContext;
}

function inspect(err: unknown): Inspected {
  const out: Inspected = { name: "", message: "", errnos: [], status: null, oauth: null, reason: null, mxCode: null, extra: {} };
  if (typeof err === "string") {
    out.message = err;
    out.status = statusFromText(err);
    return out;
  }
  if (!err || typeof err !== "object") {
    out.message = err === undefined ? "" : String(err);
    return out;
  }
  let cur: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; cur && typeof cur === "object" && !seen.has(cur) && depth < 5; depth++) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (!out.name && typeof o.name === "string") out.name = o.name;
    const msg = typeof o.message === "string" ? o.message : typeof o.error_description === "string" ? o.error_description : "";
    if (msg) out.message = out.message ? `${out.message} (${msg})` : msg;
    if (typeof o.code === "string") {
      if (isKnownErrorCode(o.code)) out.mxCode ??= o.code;
      else if (/^E[A-Z0-9_]+$|^UND_ERR_/.test(o.code) || TLS_ERRNOS.test(o.code)) out.errnos.push(o.code);
    }
    if (typeof o.errno === "string") out.errnos.push(o.errno);
    out.status ??= numeric(o.status) ?? numeric(o.statusCode) ?? numeric((o.response as Record<string, unknown> | undefined)?.status);
    if (typeof o.error === "string" && /^[a-z_]+$/.test(o.error)) out.oauth ??= o.error;
    if (o.ok === false && typeof o.reason === "string") {
      out.reason ??= o.reason;
      if (typeof o.message !== "string" && typeof o.detail === "string") out.message = o.detail;
    }
    if (typeof o.reason === "string" && !out.reason && !(cur instanceof Error)) out.reason = o.reason;
    if (out.status !== null) out.extra.httpStatus = out.status;
    cur = o.cause;
  }
  if (out.errnos.length) out.extra.errno = out.errnos[0];
  if (out.reason) out.extra.reason = out.reason;
  if (out.oauth) out.extra.oauthError = out.oauth;
  out.status ??= statusFromText(out.message);
  if (out.status !== null) out.extra.httpStatus = out.status;
  return out;
}

function numeric(v: unknown): number | null {
  return typeof v === "number" && v >= 100 && v < 600 ? v : null;
}

function statusFromText(s: string): number | null {
  const m = /\b(?:HTTP|status|Meshy|Gemini|Auth0)[\s:(]*([1-5]\d\d)\b/i.exec(s) ?? /\(([45]\d\d)\)/.exec(s);
  return m ? Number(m[1]) : null;
}

const CONNECT_ERRNOS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "EADDRNOTAVAIL"]);
const RESET_ERRNOS = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"]);
const TIMEOUT_ERRNOS = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const DNS_ERRNOS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"]);
const TLS_ERRNOS = /^(CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|EPROTO)/;

function classify(i: Inspected, service: ErrorService | undefined): Rule {
  const msg = i.message;
  const has = (re: RegExp) => re.test(msg);
  if (i.mxCode) return { code: i.mxCode as ErrorCode };

  // Named error classes from Morphix packages.
  switch (i.name) {
    case "ControllerDisabledError":
      return { code: "MX-PRINT-004" };
    case "ControlRefusedError":
      return { code: has(/authori[sz]|confirm|token/i) ? "MX-PRINT-012" : "MX-PRINT-005" };
    case "PrinterReplyTimeout":
      return { code: "MX-PRINT-002" };
    case "PrinterConnectionClosed":
      return { code: "MX-PRINT-003" };
    case "MeshyNotConfigured":
      return { code: "MX-GEN-001" };
    case "MeshFormatError":
      return { code: "MX-GEN-008" };
    case "AbortError":
      return service && has(/timeout|timed out/i) ? timeoutFor(service) : { code: "MX-SYS-004" };
    case "TimeoutError":
      return timeoutFor(service);
    case "TokenExpiredError":
      return { code: "MX-AUTH-002" };
  }

  // { ok: false, reason } results (slicer, prepare, guardian Gemini).
  if (i.reason) {
    const r = REASONS[i.reason];
    if (r) return r;
    if (i.reason === "timeout") return timeoutFor(service);
    if (i.reason === "camera_lost") return { code: "MX-GUARD-001" };
  }

  // Storage errnos are unambiguous regardless of service.
  for (const e of i.errnos) {
    if (e === "ENOSPC" || e === "EDQUOT") return { code: "MX-STORE-001" };
    if (e === "EROFS") return { code: "MX-STORE-005" };
    if (e === "EACCES" || e === "EPERM") return { code: "MX-STORE-003" };
    if (e === "ENOENT") return service === "slicer" || service === "openscad" ? toolMissing(service) : { code: "MX-STORE-002" };
    if (e === "ENOMEM") return { code: "MX-SYS-003" };
    if (e === "EADDRINUSE") return { code: "MX-PORTAL-001" };
  }
  if (has(/no space left on device|disk (is )?full/i)) return { code: "MX-STORE-001" };
  if (has(/read-only file system/i)) return { code: "MX-STORE-005" };
  if (has(/SQLITE_|database disk image is malformed|sqlite/i)) return { code: "MX-STORE-004" };

  // Connection-level failures, routed by service.
  const errno = i.errnos.find((e) => CONNECT_ERRNOS.has(e) || RESET_ERRNOS.has(e) || TIMEOUT_ERRNOS.has(e) || DNS_ERRNOS.has(e) || TLS_ERRNOS.test(e));
  if (errno) return network(errno, service);
  if (has(/fetch failed|network ?error|socket hang up/i)) return network("ECONNRESET", service);

  // Specific messages thrown by Morphix code today.
  if (has(/print(er)? control(s)? (is |are )?(locked|disabled)/i)) return { code: "MX-PRINT-004" };
  if (has(/\.gx\b.*(unverified|not (been )?verified|hasn't been verified)/i) || has(/(unverified|not verified).*\.gx/i)) return { code: "MX-PRINT-011" };
  if (has(/pause[^.]*not confirmed|unconfirmed pause/i)) return { code: service === "camera" ? "MX-GUARD-007" : "MX-PRINT-007" };
  if (has(/(print )?start[^.]*not confirmed|unconfirmed start/i)) return { code: "MX-PRINT-006" };
  if (has(/upload[^.]*not confirmed|upload failed/i)) return { code: "MX-PRINT-008" };
  if (has(/already printing|printer is busy/i)) return { code: "MX-PRINT-009" };
  if (has(/prepare the model for printing first|isn't ready \(see the preparation report\)/i)) return { code: "MX-PRINT-013" };
  if (has(/Meshy is not configured|MESHY_API_KEY/i)) return { code: "MX-GEN-001" };
  if (has(/Gemini is not configured|GEMINI_API_KEY|API_KEY_INVALID/i)) return { code: "MX-VOICE-004" };
  if (has(/Meshy task (failed|canceled|cancelled)/i)) return { code: "MX-GEN-005" };
  if (has(/Meshy task timed out/i)) return { code: "MX-GEN-006" };
  if (has(/download failed|downloaded file is too large/i)) return { code: "MX-GEN-007" };
  if (has(/Meshy returned no GLB/i)) return { code: "MX-GEN-005" };
  if (has(/no slicer installed|slicer(s)? (is |are )?not installed/i)) return { code: "MX-SLICE-001" };
  if (has(/slicer-profiles not found/i)) return { code: "MX-SLICE-002" };
  if (has(/exceeds the .*build volume|too large for the (printer|build)/i)) return { code: "MX-SLICE-006" };
  if (has(/camera.*(lost|disconnected|closed|unplugged|stopped)|camera_lost/i)) return { code: "MX-GUARD-001" };
  if (has(/no camera|camera not found/i)) return { code: "MX-GUARD-002" };
  if (has(/openscad/i)) return toolMissing("openscad");
  if (has(/recording too long/i)) return { code: "MX-VOICE-006" };
  if (has(/state mismatch|invalid state|nonce mismatch/i) && (service === "auth0" || service === "portal")) return { code: "MX-AUTH-006" };
  if (has(/^cancell?ed$|operation was aborted/i)) return { code: "MX-SYS-004" };

  // OAuth / Auth0 error fields.
  if (i.oauth) {
    const r = OAUTH[i.oauth];
    if (r) return r;
    if (service === "auth0") return { code: "MX-AUTH-001" };
  }

  if (i.status !== null) return http(i.status, service, msg);
  if (has(/timed out|timeout/i)) return timeoutFor(service);
  return null;
}

const REASONS: Record<string, Rule> = {
  "slicer-not-installed": { code: "MX-SLICE-001" },
  "profile-missing": { code: "MX-SLICE-002" },
  "slicer-failed": { code: "MX-SLICE-003" },
  "no-output": { code: "MX-SLICE-005" },
  "too-large": { code: "MX-SLICE-006" },
  "not-sliced": { code: "MX-SLICE-005" },
};
// Guardian Gemini reasons all mean "AI double-check unavailable".
for (const r of ["no_api_key", "rate_limited", "daily_cap", "image_too_large", "http_error", "network_error", "bad_response"]) REASONS[r] = { code: "MX-GUARD-006" };

const OAUTH: Record<string, Rule> = {
  access_denied: { code: "MX-AUTH-003" },
  unauthorized: { code: "MX-AUTH-003" },
  unauthorized_client: { code: "MX-AUTH-004" },
  login_required: { code: "MX-AUTH-002" },
  consent_required: { code: "MX-AUTH-002" },
  interaction_required: { code: "MX-AUTH-002" },
  invalid_token: { code: "MX-AUTH-002" },
  expired_token: { code: "MX-AUTH-002" },
  invalid_grant: { code: "MX-AUTH-001" },
  invalid_state: { code: "MX-AUTH-006" },
  missing_state: { code: "MX-AUTH-006" },
  invalid_client: { code: "MX-AUTH-004" },
  email_not_verified: { code: "MX-AUTH-007" },
  unverified_email: { code: "MX-AUTH-007" },
};

function toolMissing(service: "slicer" | "openscad"): Rule {
  return { code: service === "slicer" ? "MX-SLICE-001" : "MX-GEN-011" };
}

function timeoutFor(service: ErrorService | undefined): Rule {
  switch (service) {
    case "printer":
      return { code: "MX-PRINT-002" };
    case "slicer":
      return { code: "MX-SLICE-004" };
    case "meshy":
      return { code: "MX-GEN-006" };
    case "openscad":
      return { code: "MX-GEN-011" };
    case "auth0":
      return { code: "MX-AUTH-005" };
    case "gemini-live":
      return { code: "MX-VOICE-002" };
    case "gemini":
    case "network":
      return { code: "MX-NET-003" };
    default:
      return { code: "MX-SYS-007" };
  }
}

function network(errno: string, service: ErrorService | undefined): Rule {
  const timeout = TIMEOUT_ERRNOS.has(errno);
  const reset = RESET_ERRNOS.has(errno);
  const dns = DNS_ERRNOS.has(errno);
  const tls = TLS_ERRNOS.test(errno);
  switch (service) {
    case "printer":
      return { code: timeout ? "MX-PRINT-002" : reset ? "MX-PRINT-003" : "MX-PRINT-001" };
    case "camera":
      return { code: "MX-GUARD-001" };
    case "gemini-live":
      return { code: "MX-VOICE-002" };
    case "gemini":
      return { code: timeout ? "MX-NET-003" : dns ? "MX-NET-002" : tls ? "MX-NET-006" : "MX-GEN-010" };
    case "auth0":
      return { code: "MX-AUTH-005" };
    case "portal":
      return { code: "MX-PORTAL-002" };
  }
  if (timeout) return { code: "MX-NET-003" };
  if (dns) return { code: "MX-NET-002" };
  if (tls) return { code: "MX-NET-006" };
  return { code: "MX-NET-001" };
}

function http(status: number, service: ErrorService | undefined, msg: string): Rule {
  if (service === "meshy") {
    if (status === 401 || status === 403) return { code: "MX-GEN-002" };
    if (status === 402) return { code: "MX-GEN-003" };
    if (status === 429) return { code: "MX-GEN-004" };
    if (status === 400 && /moderat|policy|inappropriate/i.test(msg)) return { code: "MX-GEN-009" };
  }
  if (service === "gemini" || service === "gemini-live") {
    if (status === 401 || status === 403) return { code: "MX-VOICE-004" };
    if (status === 429) return { code: "MX-VOICE-005" };
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg)) return { code: "MX-VOICE-004" };
    if (status === 400 && /SAFETY|blocked/i.test(msg)) return { code: "MX-GEN-009" };
    if (status < 500) return { code: service === "gemini" ? "MX-GEN-010" : "MX-VOICE-002" };
  }
  if (service === "auth0") {
    if (status === 401) return { code: "MX-AUTH-001" };
    if (status === 403) return { code: "MX-AUTH-003" };
    if (status >= 500) return { code: "MX-AUTH-005" };
  }
  if (service === "portal") {
    if (status === 401) return { code: "MX-AUTH-002" };
    if (status === 403) return { code: "MX-AUTH-003" };
    if (status === 400) return { code: "MX-PORTAL-003" };
  }
  if (status >= 500) return { code: "MX-NET-005" };
  if (status === 401) return { code: "MX-AUTH-002" };
  if (status === 403) return { code: "MX-AUTH-003" };
  if (status === 408 || status === 504) return timeoutFor(service);
  if (status === 429) return { code: service === "meshy" ? "MX-GEN-004" : "MX-NET-005", retryable: true };
  if (status === 404 && service === "meshy") return { code: "MX-GEN-007" };
  return null;
}
