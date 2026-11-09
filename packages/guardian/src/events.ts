// Vision worker protocol (services/vision). The worker prints one JSON object
// per line on stdout; every line carries the envelope {v, seq, ts, session, type}.
// parseVisionLine never throws: anything malformed comes back as null.

export const VISION_PROTOCOL_VERSION = 1;

export type FailureKind = "spaghetti" | "detachment" | "stalled";
export const FAILURE_KINDS: readonly FailureKind[] = ["spaghetti", "detachment", "stalled"];

export interface Envelope {
  v: number;
  seq: number;
  ts: string;
  session: string | null;
}

export interface ConfirmWindow {
  hits: number;
  of: number;
  need: number;
  size: number;
}

export interface ObservationMetrics {
  brightness: number;
  contrast: number;
  motion?: number;
  moving_fraction?: number;
  roi_change?: number;
  outside_change?: number;
  edge_density?: number;
  edge_baseline?: number;
  thin_density?: number;
  thin_baseline?: number;
  spaghetti_score?: number;
  still_seconds?: number;
}

export type VisionEvent = Envelope &
  (
    | { type: "started"; pid: number; snapshot_url: string; interval: number; evidence_dir: string | null; roi: number[]; confirm: { n: number; m: number } }
    | { type: "stopped"; frames: number }
    | { type: "camera_ok"; width: number; height: number; recovered_from: "lost" | "frozen" | null }
    | { type: "camera_lost"; reason: string; detail: string; consecutive_failures: number }
    | { type: "frame_error"; reason: string; detail: string; consecutive_failures: number }
    | { type: "frozen_frame"; identical_frames: number }
    | {
        type: "observation";
        frame: number;
        printer_state: string | null;
        detection_active: boolean;
        warmed_up?: boolean;
        duplicate_frame?: boolean;
        suspicions: FailureKind[];
        metrics: ObservationMetrics;
      }
    | { type: "possible_failure"; kind: FailureKind; score: number; window: ConfirmWindow; evidence: string | null }
    | { type: "confirmed_failure"; kind: FailureKind; score: number; window: ConfirmWindow; evidence: string | null; evidence_frames: string[] }
    | { type: "suspicion_cleared"; kind: FailureKind; reason: string; was_confirmed: boolean }
    | { type: "heartbeat"; frames: number; camera: "unknown" | "ok" | "lost" | "frozen"; printer_state: string | null; detection_active: boolean; uptime_s: number; evidence_saved: number }
    | { type: "warning"; detail: string }
  );

export type VisionEventType = VisionEvent["type"];
export type VisionEventOf<T extends VisionEventType> = Extract<VisionEvent, { type: T }>;

const KNOWN_TYPES = new Set<string>([
  "started", "stopped", "camera_ok", "camera_lost", "frame_error", "frozen_frame", "observation",
  "possible_failure", "confirmed_failure", "suspicion_cleared", "heartbeat", "warning",
]);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Parse one stdout line. Returns null for blank, non-JSON, unknown or malformed lines. */
export function parseVisionLine(line: string): VisionEvent | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || typeof raw.type !== "string" || !KNOWN_TYPES.has(raw.type)) return null;
  if (typeof raw.seq !== "number" || typeof raw.ts !== "string") return null;
  if (raw.type === "possible_failure" || raw.type === "confirmed_failure" || raw.type === "suspicion_cleared") {
    if (!FAILURE_KINDS.includes(raw.kind as FailureKind)) return null;
  }
  if (raw.type === "confirmed_failure" && !Array.isArray(raw.evidence_frames)) raw.evidence_frames = [];
  if (raw.type === "observation" && (!isObj(raw.metrics) || !Array.isArray(raw.suspicions))) return null;
  return raw as unknown as VisionEvent;
}

/**
 * Re-assembles newline-delimited text from arbitrary stream chunks. Handles
 * CRLF, split multi-byte characters (when fed Buffers) and drops runaway
 * lines longer than maxLineBytes instead of buffering forever.
 */
export class LineSplitter {
  private buf = "";
  private discarding = false;
  private decoder = new TextDecoder("utf-8");

  constructor(private readonly maxLineBytes = 1024 * 1024) {}

  push(chunk: string | Uint8Array): string[] {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (this.discarding) this.discarding = false;
      else out.push(line);
    }
    if (this.buf.length > this.maxLineBytes) {
      this.buf = "";
      this.discarding = true;
    }
    return out;
  }

  /** Flush a trailing line without newline (call when the stream ends). */
  end(): string[] {
    const rest = this.buf;
    this.buf = "";
    const wasDiscarding = this.discarding;
    this.discarding = false;
    return rest.trim() && !wasDiscarding ? [rest.replace(/\r$/, "")] : [];
  }
}
