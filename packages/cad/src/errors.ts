// MX-CAD-nnn error codes for the Claude + OpenSCAD generator (see docs/CAD.md).
// Codes are stable: the coordinator folds them into the shared error registry.
// 00x input/config, 01x Claude API, 02x OpenSCAD, 03x output checks.

export const CAD_ERRORS = {
  "MX-CAD-001": { key: "INPUT_INVALID", retryable: false, message: "The design request has no description." },
  "MX-CAD-002": { key: "CLAUDE_NOT_CONFIGURED", retryable: false, message: "Claude is not configured (ANTHROPIC_API_KEY missing)." },
  "MX-CAD-003": { key: "ABORTED", retryable: false, message: "The design was cancelled." },

  "MX-CAD-010": { key: "CLAUDE_HTTP", retryable: true, message: "The Claude API returned an HTTP error." },
  "MX-CAD-011": { key: "CLAUDE_AUTH", retryable: false, message: "The Claude API rejected the API key." },
  "MX-CAD-012": { key: "CLAUDE_RATE_LIMITED", retryable: true, message: "Claude rate limit reached or the API is overloaded." },
  "MX-CAD-013": { key: "CLAUDE_NETWORK", retryable: true, message: "The Claude API could not be reached (network error or timeout)." },
  "MX-CAD-014": { key: "CLAUDE_REFUSED", retryable: false, message: "Claude declined to design this object." },
  "MX-CAD-015": { key: "CLAUDE_BAD_REQUEST", retryable: false, message: "The Claude API rejected the request (bad model name or parameter)." },

  "MX-CAD-020": { key: "OPENSCAD_MISSING", retryable: false, message: "The openscad program is not installed (sudo apt install openscad)." },
  "MX-CAD-021": { key: "DESIGN_FAILED", retryable: true, message: "Claude could not produce a printable design within the allowed attempts." },
} as const;

export type CadErrorCode = keyof typeof CAD_ERRORS;

export class CadError extends Error {
  readonly code: CadErrorCode;
  readonly retryable: boolean;
  /** Last generated OpenSCAD source, when there was one (for logs and bug reports). */
  readonly scad?: string;

  constructor(code: CadErrorCode, message?: string, scad?: string) {
    super(message ?? CAD_ERRORS[code].message);
    this.name = "CadError";
    this.code = code;
    this.retryable = CAD_ERRORS[code].retryable;
    this.scad = scad;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CadError("MX-CAD-003");
}
