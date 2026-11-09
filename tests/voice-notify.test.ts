// Gemini cutting out: app events ("your model is ready") used to be sent while Gemini was
// still answering, which interrupts it mid-sentence. They now wait for the turn to finish.
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceController } from "../apps/desktop/electron/voice";
import { AudioOut, PLAYBACK_LEAD_S } from "../apps/desktop/src/audio";

function setup() {
  const sent: string[] = [];
  const ctx: any = { event: () => {}, send: () => {}, log: { write: () => {} }, db: { run: () => {}, get: () => null, flush: () => {} }, url: () => null };
  const v = new VoiceController(ctx, {} as any, { apiKey: undefined, model: "m", meshyBalance: async () => null, printing: () => null, smartSearch: {} as any });
  (v as any).live = { connected: true, sendText: (t: string) => sent.push(t) };
  const geminiAnswering = () => ((v as any).turn = { startedAt: Date.now(), audioBytes: 0, user: "", assistant: "Claude is designing your", audioRel: null, system: true });
  const geminiDone = () => (v as any).finishTurn();
  return { v, sent, geminiAnswering, geminiDone };
}

afterEach(() => vi.useRealTimers());

describe("app events don't cut Gemini off", () => {
  it("sends straight away when Gemini is quiet", async () => {
    const t = setup();
    await t.v.notify("The model is ready.");
    expect(t.sent).toEqual(["[Morphix event] The model is ready."]);
  });

  it("waits until Gemini finishes speaking, then sends everything together", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.geminiAnswering();
    await t.v.notify("Claude finished the case.");
    await t.v.notify("The print is sliced.");
    expect(t.sent).toEqual([]); // Gemini keeps talking
    t.geminiDone();
    vi.advanceTimersByTime(300);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain("(1) Claude finished the case. (2) The print is sliced.");
  });

  it("sends anyway after 20 s if the turn never finishes", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.geminiAnswering();
    await t.v.notify("The printer confirmed the print has started.");
    vi.advanceTimersByTime(19_000);
    expect(t.sent).toEqual([]);
    vi.advanceTimersByTime(1_500);
    expect(t.sent).toEqual(["[Morphix event] The printer confirmed the print has started."]);
  });
});

describe("speaker buffer", () => {
  it("queues a little audio before starting and after a late chunk", () => {
    const starts: number[] = [];
    let now = 10;
    class FakeCtx {
      state = "running";
      destination = {};
      get currentTime() { return now; }
      createBuffer(_c: number, n: number, rate: number) { return { duration: n / rate, getChannelData: () => new Float32Array(n) }; }
      createBufferSource() { return { buffer: null as any, connect() {}, start: (at: number) => starts.push(at), stop() {}, onended: null }; }
    }
    vi.stubGlobal("AudioContext", FakeCtx);
    const out = new AudioOut();
    const chunk = new Int16Array(2400).buffer; // 0.1 s at 24 kHz
    out.play(chunk, 24000);
    out.play(chunk, 24000);
    expect(starts[0]).toBeCloseTo(10 + PLAYBACK_LEAD_S);
    expect(starts[1]).toBeCloseTo(10 + PLAYBACK_LEAD_S + 0.1); // back to back, no gap
    now = 20; // the next chunk arrives late: re-buffer instead of a stutter
    out.play(chunk, 24000);
    expect(starts[2]).toBeCloseTo(20 + PLAYBACK_LEAD_S);
    vi.unstubAllGlobals();
  });
});

describe("guardian alarm answers", () => {
  it("'I've checked' means keep printing (and stops the alarm)", async () => {
    const { classifyWarningAnswer } = await import("../apps/desktop/electron/guardian-voice");
    expect(classifyWarningAnswer("I've checked")).toBe("keep");
    expect(classifyWarningAnswer("I have checked, it's fine")).toBe("keep");
    expect(classifyWarningAnswer("yes stop it")).toBe("stop");
  });
});
