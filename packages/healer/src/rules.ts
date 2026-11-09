// Pure classification: log lines and job events -> incidents. No side effects.
import type { Incident, JobEventLike, JobLike, JobStageLike } from "./types";

/** "Printer refused control" in its various spellings (ControlRefusedError, raw reply). */
export const CONTROL_REFUSED_RE = /refused control|control failed/i;
/** Gemini Live closes that just mean "nobody talked for a while". */
export const INACTIVITY_CLOSE_RE = /inactiv|idle|session (?:has )?expired|deadline|time ?limit/i;
/** Slicer failures worth one retry with safer settings (not "missing slicer" or "too big"). */
export const SLICE_RETRY_CODES = new Set(["MX-SLICE-003", "MX-SLICE-005", "MX-SLICE-010"]);
/** Generation failures where the Meshy task itself may still be fine (network / polling). */
export const MESHY_RESUME_CODES = new Set(["MX-NET-001", "MX-NET-002", "MX-NET-003", "MX-NET-005", "MX-GEN-004", "MX-GEN-006", "MX-GEN-007", "MX-SYS-007"]);

/** Log messages that are part of normal operation or handled elsewhere: never "unknown". */
const QUIET_ERRORS = [/^self-heal/, /^\[console\]/, /^generation failed$/, /^print prepare failed$/];

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  extra?: unknown;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Normalise a message for de-duplication (drop numbers, ids, paths). */
export function fingerprint(s: string): string {
  return s
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Classify one log line. Voice-turn bookkeeping is done by the engine, not here. */
export function classifyLog(line: LogLine): Incident | null {
  const { level, message } = line;
  const x = rec(line.extra);
  if (message.startsWith("self-heal")) return null;

  if (message === "Gemini session closed") {
    const reason = str(x.reason) || "closed";
    return { kind: "gemini-closed", key: "gemini", what: `Gemini socket closed (${reason})`, context: { reason, inactivity: INACTIVITY_CLOSE_RE.test(reason) } };
  }

  if (message === "printer-control") {
    if (x.op === "recoverControl") {
      return { kind: "printer-stale-lock-cleared", key: "printer", what: "printer had a stale control lock", context: { reason: str(x.reason) } };
    }
    if (CONTROL_REFUSED_RE.test(str(x.error))) {
      return { kind: "printer-control-refused", key: "printer", what: `printer refused control during ${str(x.op) || "a command"}`, code: "MX-PRINT-005", context: { op: x.op, error: str(x.error) } };
    }
    return null;
  }

  if (message.startsWith("[guardian]") && /\b(worker|vision)\b.*\b(failed|gave up|exited|crash)/i.test(message)) {
    return { kind: "guardian-worker-down", key: "guardian", what: "print watcher stopped", code: "MX-GUARD-003", context: { line: message.slice(0, 200) } };
  }

  const blob = `${message} ${str(x.error)} ${str(x.message)} ${str(x.reason)}`;
  if (/ENOSPC|no space left|not enough disk space/i.test(blob)) {
    return { kind: "disk-low", key: "disk", what: "the disk is full", code: "MX-STORE-001" };
  }

  if (level === "error" && !QUIET_ERRORS.some((re) => re.test(message))) {
    const detail = str(x.error) || str(x.message) || str(x.reason);
    return { kind: "unknown-error", key: fingerprint(`${message} ${detail}`), what: detail ? `${message}: ${detail.slice(0, 160)}` : message, context: { message, detail: detail.slice(0, 400) } };
  }
  return null;
}

export function failedStage(job: JobLike): JobStageLike | undefined {
  return job.stages.find((s) => s.status === "failed");
}

/** Classify a JobManager event (only failures and restarts matter). */
export function classifyJobEvent(ev: JobEventLike, isKnownCode: (code: string) => boolean = () => true): Incident | null {
  const job = ev.job;
  if (ev.type === "restored" && job.status === "interrupted") {
    return { kind: "job-interrupted", key: job.id, what: `${job.kind} job was running when Morphix restarted`, code: "MX-SYS-006", context: { jobId: job.id, jobKind: job.kind } };
  }
  if (ev.type !== "finished" || job.status !== "failed") return null;
  const stage = failedStage(job);
  const err = stage?.error ?? job.error;
  const code = err?.code ?? "MX-SYS-001";
  const message = err?.message ?? err?.title ?? "";
  const base = { jobId: job.id, jobKind: job.kind, stage: stage?.key, code, message: message.slice(0, 300) };

  if (job.kind === "prepare" && SLICE_RETRY_CODES.has(code) && stage && /^prepare\.(slice|gx)$/.test(stage.key)) {
    const versionId = str(job.meta?.versionId);
    return { kind: "slicer-failed", key: versionId || job.id, what: `slicing failed (${code})`, code, context: { ...base, versionId, owner: job.owner } };
  }
  if ((job.kind === "text-to-print" || job.kind === "photo-to-print") && MESHY_RESUME_CODES.has(code) && (stage?.key === "generate" || stage?.key === "download")) {
    const taskId = str(job.meta?.taskId);
    if (taskId) return { kind: "meshy-poll-failed", key: taskId, what: `checking the Meshy model failed (${code})`, code, context: { ...base, taskId } };
  }
  if (code === "MX-GUARD-003") return { kind: "guardian-worker-down", key: "guardian", what: "print watcher stopped", code, context: base };
  if (code === "MX-VOICE-002") return { kind: "gemini-closed", key: "gemini", what: "Gemini connection lost", code, context: { ...base, reason: message, inactivity: false } };
  if (code === "MX-STORE-001") return { kind: "disk-low", key: "disk", what: "the disk is full", code, context: base };
  if (code === "MX-PRINT-005" && CONTROL_REFUSED_RE.test(message)) return { kind: "printer-control-refused", key: "printer", what: "printer refused control", code, context: base };
  if (code === "MX-SYS-001" || !isKnownCode(code)) {
    return { kind: "unknown-error", key: fingerprint(`${job.kind} ${stage?.key ?? ""} ${message}`), what: `${job.kind} failed: ${message.slice(0, 160) || code}`, code, context: base };
  }
  return null;
}
