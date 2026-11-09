// MX-P3D-nnn error codes for the photo-to-model pipeline (see docs/PHOTO3D.md).
// Codes are stable: the coordinator folds them into the shared error registry.
// The tens digit groups the area: 00x input, 01x Gemini, 02x Meshy, 03x OpenSCAD,
// 04x scan import, 05x output checks, 06x photo cleanup, 07x CAD route, 08x phone plans, 09x pipeline.

export const P3D_ERRORS = {
  "MX-P3D-001": { key: "INPUT_INVALID", retryable: false, message: "The request is missing photos or a description, or a photo is not a supported image." },
  "MX-P3D-002": { key: "INPUT_TOO_LARGE", retryable: false, message: "A photo (or all photos together) is too large to send for analysis." },

  "MX-P3D-010": { key: "GEMINI_NOT_CONFIGURED", retryable: false, message: "Gemini is not configured (GEMINI_API_KEY missing)." },
  "MX-P3D-011": { key: "GEMINI_HTTP", retryable: true, message: "Gemini returned an HTTP error." },
  "MX-P3D-012": { key: "GEMINI_NETWORK", retryable: true, message: "Gemini could not be reached (network error or timeout)." },
  "MX-P3D-013": { key: "GEMINI_BAD_RESPONSE", retryable: true, message: "Gemini's answer was not the expected JSON." },
  "MX-P3D-014": { key: "GEMINI_BLOCKED", retryable: false, message: "Gemini refused the request (safety block or empty answer)." },
  "MX-P3D-015": { key: "GEMINI_RATE_LIMITED", retryable: true, message: "Gemini rate limit or quota reached." },

  "MX-P3D-020": { key: "MESHY_NOT_CONFIGURED", retryable: false, message: "Meshy is not configured (MESHY_API_KEY missing)." },
  "MX-P3D-021": { key: "MESHY_BAD_REQUEST", retryable: false, message: "Meshy rejected the request (bad image or option)." },
  "MX-P3D-022": { key: "MESHY_AUTH", retryable: false, message: "Meshy rejected the API key." },
  "MX-P3D-023": { key: "MESHY_NO_CREDITS", retryable: false, message: "Not enough Meshy credits (or the plan cannot use the API)." },
  "MX-P3D-024": { key: "MESHY_MODERATION", retryable: false, message: "Meshy's content moderation blocked an image." },
  "MX-P3D-025": { key: "MESHY_RATE_LIMITED", retryable: true, message: "Meshy rate limit reached." },
  "MX-P3D-026": { key: "MESHY_HTTP", retryable: true, message: "Meshy returned an unexpected HTTP error." },
  "MX-P3D-027": { key: "MESHY_TASK_FAILED", retryable: true, message: "The Meshy task failed or was cancelled (failed tasks are refunded)." },
  "MX-P3D-028": { key: "MESHY_TIMEOUT", retryable: true, message: "The Meshy task did not finish in time; it can be resumed by task id." },
  "MX-P3D-029": { key: "MESHY_NO_MODEL", retryable: false, message: "Meshy finished but returned no GLB or STL, or the download failed." },
  "MX-P3D-030": { key: "OPENSCAD_MISSING", retryable: false, message: "The openscad program is not installed (sudo apt install openscad)." },
  "MX-P3D-031": { key: "OPENSCAD_UNSAFE", retryable: true, message: "Generated OpenSCAD code failed the safety checks." },
  "MX-P3D-032": { key: "OPENSCAD_COMPILE_FAILED", retryable: true, message: "OpenSCAD could not compile the generated design after 3 attempts." },
  "MX-P3D-033": { key: "OPENSCAD_TIMEOUT", retryable: true, message: "OpenSCAD took too long to render the design." },
  "MX-P3D-034": { key: "OPENSCAD_EMPTY", retryable: true, message: "The OpenSCAD design produced no geometry." },
  "MX-P3D-035": { key: "OPENSCAD_NO_SPEC", retryable: false, message: "There is no design spec to build an OpenSCAD model from." },

  "MX-P3D-040": { key: "SCAN_UNSUPPORTED", retryable: false, message: "The scan file format is not supported (use OBJ, PLY, STL or GLB)." },
  "MX-P3D-041": { key: "SCAN_PARSE_FAILED", retryable: false, message: "The scan file could not be read (corrupt or unsupported variant)." },
  "MX-P3D-042": { key: "SCAN_NO_FACES", retryable: false, message: "The scan has no triangles (a point cloud); export it as a mesh." },
  "MX-P3D-043": { key: "SCAN_UNITS_UNCERTAIN", retryable: false, message: "The scan's units could not be determined with confidence; millimetres were assumed." },

  "MX-P3D-050": { key: "DIMENSION_MISMATCH", retryable: false, message: "The model's size differs from the intended dimensions by more than the tolerance." },
  "MX-P3D-051": { key: "EXCEEDS_BUILD_VOLUME", retryable: false, message: "The model is larger than the printer's build volume." },
  "MX-P3D-052": { key: "MESH_NOT_PRINTABLE", retryable: false, message: "The resulting mesh has problems that may stop slicing." },
  "MX-P3D-053": { key: "DIMENSIONS_UNCERTAIN", retryable: false, message: "Dimensions are estimates with low confidence; check them before printing." },

  "MX-P3D-060": { key: "CLEANUP_FAILED", retryable: true, message: "Gemini could not clean up the photo; the original photo is used instead." },
  "MX-P3D-061": { key: "CLEANUP_NOT_CONFIGURED", retryable: false, message: "Photo cleanup needs GEMINI_API_KEY and an image-capable Gemini model." },

  "MX-P3D-070": { key: "CAD_NOT_AVAILABLE", retryable: false, message: "Claude CAD is not available on this Morphix yet. Choose Meshy, or try again after the CAD update." },
  "MX-P3D-071": { key: "CAD_FAILED", retryable: true, message: "Claude CAD could not design this part." },

  "MX-P3D-080": { key: "PLAN_NOT_FOUND", retryable: false, message: "That photo plan has expired. Take or choose the photo again." },
  "MX-P3D-081": { key: "PLAN_ROUTE_UNAVAILABLE", retryable: false, message: "That way of making the model is not available right now." },

  "MX-P3D-090": { key: "CANCELLED", retryable: true, message: "The job was cancelled." },
  "MX-P3D-091": { key: "ALL_ENGINES_FAILED", retryable: true, message: "No engine could produce a model." },
  "MX-P3D-092": { key: "BUDGET_EXCEEDED", retryable: false, message: "The engine would cost more Meshy credits than allowed." },
  "MX-P3D-099": { key: "INTERNAL", retryable: false, message: "Unexpected internal error." },
} as const;

export type P3dErrorCode = keyof typeof P3D_ERRORS;

export class Photo3dError extends Error {
  readonly code: P3dErrorCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(code: P3dErrorCode, message?: string, detail?: string) {
    super(message ?? P3D_ERRORS[code].message);
    this.name = "Photo3dError";
    this.code = code;
    this.retryable = P3D_ERRORS[code].retryable;
    this.detail = detail;
  }
}

/** Plain, serialisable form (safe to send over IPC or to the portal). */
export interface P3dIssue {
  code: P3dErrorCode;
  message: string;
  detail?: string;
}

export function issue(code: P3dErrorCode, message?: string, detail?: string): P3dIssue {
  return detail === undefined ? { code, message: message ?? P3D_ERRORS[code].message } : { code, message: message ?? P3D_ERRORS[code].message, detail };
}

export function toIssue(e: unknown): P3dIssue {
  if (e instanceof Photo3dError) return issue(e.code, e.message, e.detail);
  if (e instanceof Error && /cancel|abort/i.test(e.message + e.name)) return issue("MX-P3D-090");
  return issue("MX-P3D-099", undefined, e instanceof Error ? e.message : String(e));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Photo3dError("MX-P3D-090");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Photo3dError("MX-P3D-090"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(new Photo3dError("MX-P3D-090"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
