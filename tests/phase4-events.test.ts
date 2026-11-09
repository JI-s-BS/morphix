import { describe, expect, it } from "vitest";
import { LineSplitter, parseVisionLine } from "@morphix/guardian";

const env = { v: 1, seq: 1, ts: "2026-11-07T06:00:00.000+00:00", session: "s1" };
const line = (o: object) => JSON.stringify({ ...env, ...o });

describe("vision event parsing", () => {
  it("parses every known event type", () => {
    const events = [
      { type: "started", pid: 1, snapshot_url: "u", interval: 10, evidence_dir: null, roi: [0, 0, 1, 1], confirm: { n: 3, m: 5 } },
      { type: "camera_ok", width: 1280, height: 720, recovered_from: null },
      { type: "camera_lost", reason: "fetch_error", detail: "timeout", consecutive_failures: 3 },
      { type: "frozen_frame", identical_frames: 7 },
      { type: "observation", frame: 3, printer_state: null, detection_active: true, suspicions: [], metrics: { brightness: 90, contrast: 20 } },
      { type: "possible_failure", kind: "spaghetti", score: 2.1, window: { hits: 1, of: 5, need: 3, size: 5 }, evidence: "/x.jpg" },
      { type: "confirmed_failure", kind: "stalled", score: 600, window: { hits: 3, of: 5, need: 3, size: 5 }, evidence: null, evidence_frames: [] },
      { type: "suspicion_cleared", kind: "detachment", reason: "no_longer_detected", was_confirmed: false },
      { type: "heartbeat", frames: 10, camera: "ok", printer_state: "READY", detection_active: false, uptime_s: 60, evidence_saved: 0 },
      { type: "warning", detail: "x" },
      { type: "stopped", frames: 10 },
    ];
    for (const e of events) expect(parseVisionLine(line(e))?.type).toBe(e.type);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "   ", "Traceback (most recent call last):", "{not json", "[1,2]", "null",
      line({ type: "nope" }), JSON.stringify({ type: "warning", detail: "no envelope" }),
      line({ type: "possible_failure", kind: "aliens", score: 1, window: {}, evidence: null }),
      line({ type: "observation", frame: 1 })]) {
      expect(parseVisionLine(bad)).toBeNull();
    }
  });

  it("defaults missing evidence_frames on confirmed_failure", () => {
    const e = parseVisionLine(line({ type: "confirmed_failure", kind: "spaghetti", score: 3, window: { hits: 3, of: 3, need: 3, size: 5 }, evidence: null }));
    expect(e?.type === "confirmed_failure" && e.evidence_frames).toEqual([]);
  });
});

describe("LineSplitter", () => {
  it("reassembles chunks, CRLF and split UTF-8", () => {
    const s = new LineSplitter();
    expect(s.push("ab")).toEqual([]);
    expect(s.push("c\r\nde")).toEqual(["abc"]);
    const bytes = new TextEncoder().encode("fé\n");
    expect(s.push(bytes.slice(0, 2))).toEqual([]);
    expect(s.push(bytes.slice(2))).toEqual(["defé"]);
    expect(s.push("tail")).toEqual([]);
    expect(s.end()).toEqual(["tail"]);
  });

  it("drops runaway lines instead of buffering forever", () => {
    const s = new LineSplitter(10);
    expect(s.push("x".repeat(50))).toEqual([]);
    expect(s.push("more\nok\n")).toEqual(["ok"]);
  });
});
