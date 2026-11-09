// Spoken Print Guardian warnings, with simulated failures only: a fake voice, a fake
// printer cancel and a fake clock. No printer, network or speaker is touched.
import { describe, expect, it } from "vitest";
import {
  GuardianVoice, classifyWarningAnswer, describeProblem, warningText, type GuardianAlertLike, type GuardianVoiceDeps, type IncidentView,
} from "../apps/desktop/electron/guardian-voice";
import { parseWav } from "../apps/desktop/electron/tts";
import { heightForDimension } from "@morphix/slicing";

function rig(over: Partial<GuardianVoiceDeps> = {}, opts = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const calls: string[] = [];
  const spoken: { via: string; text: string }[] = [];
  const views: (IncidentView | null)[] = [];
  let busy = false;
  const deps: GuardianVoiceDeps = {
    interrupt: () => calls.push("interrupt"),
    speakGemini: async (text) => {
      spoken.push({ via: "gemini", text });
      return true;
    },
    speakLocal: async (text) => {
      spoken.push({ via: "local", text });
      return true;
    },
    cancelPrint: async () => {
      calls.push("cancel");
      return { ok: true, message: "Printer confirmed the print was cancelled" };
    },
    keepPrinting: () => calls.push("keep"),
    resolveAlert: () => calls.push("resolve"),
    userBusy: () => busy,
    onChange: (v) => views.push(v),
    log: () => {},
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => t,
    ...over,
  };
  const gv = new GuardianVoice(deps, { repeatMs: 60_000, maxAnnouncements: 3, quietAfterKeepMs: 600_000, busyRetryMs: 8_000, ...opts });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    t += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > t) break;
      timers.shift();
      due.fn();
      await flush();
    }
    await flush();
  };
  return { gv, calls, spoken, views, advance, flush, setBusy: (b: boolean) => (busy = b), pending: () => timers.length };
}

const alert = (id = "a1", state = "confirmed_failure", kind = "spaghetti"): GuardianAlertLike => ({ id, kind, state });

describe("spoken guardian warning", () => {
  it("interrupts, then speaks a warning describing the problem and asking to stop — once per incident", async () => {
    const r = rig();
    r.gv.onAlert(alert());
    await r.flush();
    expect(r.calls[0]).toBe("interrupt");
    expect(r.spoken).toHaveLength(1);
    expect(r.spoken[0].via).toBe("gemini");
    expect(r.spoken[0].text).toMatch(/spaghetti/);
    expect(r.spoken[0].text).toMatch(/stop the print\?/);
    // The same alert arriving again (every guardian snapshot) is not a new incident.
    r.gv.onAlert(alert());
    r.gv.onAlert(alert());
    await r.flush();
    expect(r.spoken).toHaveLength(1);
    expect(r.gv.view()).toMatchObject({ alertId: "a1", awaitingAnswer: true, announcements: 1, lastSpokenBy: "gemini" });
  });

  it("does not speak for a possible (unconfirmed) problem", async () => {
    const r = rig();
    r.gv.onAlert(alert("a1", "possible_failure"));
    await r.flush();
    expect(r.spoken).toHaveLength(0);
    expect(r.gv.open).toBe(false);
  });

  it("falls back to the local voice when Gemini can't speak, and reports when nothing can", async () => {
    const r = rig({ speakGemini: async () => false });
    r.gv.onAlert(alert());
    await r.flush();
    expect(r.spoken.map((s) => s.via)).toEqual(["local"]);
    expect(r.gv.view()?.lastSpokenBy).toBe("local");

    const broken = rig({
      speakGemini: async () => {
        throw new Error("network down");
      },
      speakLocal: async () => {
        throw new Error("no audio device");
      },
    });
    broken.gv.onAlert(alert());
    await broken.flush();
    expect(broken.gv.view()).toMatchObject({ lastSpokenBy: "none", awaitingAnswer: true }); // still on screen
  });

  it("repeats at a controlled interval, at most 3 times in total, then stays quiet", async () => {
    const r = rig();
    r.gv.onAlert(alert());
    await r.flush();
    await r.advance(59_000);
    expect(r.spoken).toHaveLength(1);
    await r.advance(1_000);
    expect(r.spoken).toHaveLength(2);
    expect(r.spoken[1].text).toMatch(/^Reminder/);
    await r.advance(60_000);
    expect(r.spoken).toHaveLength(3);
    await r.advance(10 * 60_000);
    expect(r.spoken).toHaveLength(3);
    expect(r.gv.view()).toMatchObject({ awaitingAnswer: true, announcements: 3 });
  });

  it("waits for the user to finish talking before a repeat", async () => {
    const r = rig();
    r.gv.onAlert(alert());
    await r.flush();
    r.setBusy(true);
    await r.advance(60_000);
    expect(r.spoken).toHaveLength(1);
    r.setBusy(false);
    await r.advance(8_000);
    expect(r.spoken).toHaveLength(2);
  });

  it("'yes, stop it' cancels through the printer and only then says it stopped", async () => {
    let finish: (v: { ok: boolean; message: string }) => void = () => {};
    const r = rig({ cancelPrint: () => new Promise((res) => (finish = res)) });
    r.gv.onAlert(alert());
    await r.flush();
    const p = r.gv.answer("stop", "voice");
    await r.flush();
    expect(r.spoken.some((s) => /stopped/.test(s.text))).toBe(false); // printer hasn't confirmed yet
    expect(r.spoken.at(-1)?.text).toMatch(/asking the printer to stop/);
    finish({ ok: true, message: "confirmed" });
    const res = await p;
    await r.flush();
    expect(res).toMatchObject({ ok: true, stopped: true });
    expect(r.spoken.at(-1)?.text).toBe("The printer confirmed the print has stopped.");
    expect(r.calls).toContain("resolve");
    expect(r.gv.open).toBe(false);
    await r.advance(10 * 60_000);
    expect(r.spoken.filter((s) => /Reminder/.test(s.text))).toHaveLength(0); // no repeats after answering
  });

  it("an unconfirmed stop keeps the alert open and says so, without repeating", async () => {
    const r = rig({ cancelPrint: async () => ({ ok: false, message: "Cancel not confirmed" }) });
    r.gv.onAlert(alert());
    await r.flush();
    const res = await r.gv.answer("stop", "touch");
    await r.flush();
    expect(res).toMatchObject({ ok: false, stopped: false });
    expect(r.spoken.at(-1)?.text).toMatch(/has not confirmed/);
    expect(r.spoken.some((s) => s.text.includes("confirmed the print has stopped"))).toBe(false);
    expect(r.gv.view()).toMatchObject({ awaitingAnswer: true });
    await r.advance(10 * 60_000);
    expect(r.spoken.filter((s) => /Reminder/.test(s.text))).toHaveLength(0);
  });

  it("'no, keep printing' dismisses like 'It's fine' and keeps the same kind quiet for a while", async () => {
    const r = rig();
    r.gv.onAlert(alert("a1"));
    await r.flush();
    await r.gv.answer("keep", "voice");
    await r.flush();
    expect(r.calls).toContain("keep");
    expect(r.calls).not.toContain("cancel");
    expect(r.gv.open).toBe(false);
    r.gv.onAlert(alert("a2")); // same spaghetti a minute later
    await r.flush();
    expect(r.spoken.filter((s) => /Warning!/.test(s.text))).toHaveLength(1);
    await r.advance(600_000);
    r.gv.onAlert(alert("a3"));
    await r.flush();
    expect(r.spoken.filter((s) => /Warning!/.test(s.text))).toHaveLength(2);
  });

  it("answering on the touchscreen (pause / resolved) closes the spoken incident", async () => {
    const r = rig();
    r.gv.onAlert(alert());
    await r.flush();
    r.gv.onAlert(alert("a1", "pause_requested"));
    expect(r.gv.open).toBe(false);
    await r.advance(10 * 60_000);
    expect(r.spoken).toHaveLength(1);
  });

  it("refuses an answer when nothing is waiting, and handles one answer only", async () => {
    const r = rig();
    expect((await r.gv.answer("stop", "voice")).ok).toBe(false);
    r.gv.onAlert(alert());
    await r.flush();
    const [a, b] = await Promise.all([r.gv.answer("stop", "voice"), r.gv.answer("stop", "touch")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(r.calls.filter((c) => c === "cancel")).toHaveLength(1);
  });

  it("a simulated warning never sends printer commands", async () => {
    const r = rig();
    r.gv.simulate();
    await r.flush();
    expect(r.spoken[0].text).toMatch(/Warning!/);
    expect(r.gv.view()?.simulated).toBe(true);
    const res = await r.gv.answer("stop", "voice");
    expect(res).toMatchObject({ ok: true, stopped: false });
    r.gv.simulate();
    await r.flush();
    await r.gv.answer("keep", "touch");
    expect(r.calls.filter((c) => ["cancel", "keep", "resolve"].includes(c))).toEqual([]);
  });
});

describe("understanding the answer", () => {
  it.each([
    ["Yes, stop it", "stop"],
    ["yeah please stop the print", "stop"],
    ["cancel it", "stop"],
    ["Stop!", "stop"],
    ["No, keep printing", "keep"],
    ["no", "keep"],
    ["keep going, it's fine", "keep"],
    ["don't stop", "keep"],
    ["do not cancel it", "keep"],
    ["let it finish", "keep"],
    ["no, stop it", null],
    ["yes keep printing", null],
    ["what?", null],
    ["", null],
  ] as const)("%s → %s", (said, expected) => {
    expect(classifyWarningAnswer(said)).toBe(expected);
  });
});

describe("warning wording", () => {
  it("describes known problems and adds a short AI explanation", () => {
    expect(describeProblem("detachment")).toMatch(/come loose from the bed/);
    expect(describeProblem("spaghetti", "Loose strands near the nozzle.")).toMatch(/spaghetti.*Loose strands near the nozzle$/);
    expect(describeProblem("spaghetti", "x".repeat(300))).not.toMatch(/xxx/);
    expect(warningText("p", 0)).toMatch(/^Warning! .*yes, stop it, or no, keep printing\.$/);
  });
});

describe("local voice WAV", () => {
  it("reads espeak-ng's streamed WAV (unknown data size) and mixes stereo to mono", () => {
    const samples = [100, -100, 2000, -2000];
    const mk = (channels: number, dataSize: number) => {
      const data = Buffer.alloc(samples.length * 2 * channels);
      samples.forEach((v, i) => {
        for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
      });
      const h = Buffer.alloc(44);
      h.write("RIFF", 0);
      h.writeUInt32LE(0xffffffff, 4);
      h.write("WAVE", 8);
      h.write("fmt ", 12);
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(channels, 22);
      h.writeUInt32LE(22050, 24);
      h.writeUInt32LE(22050 * 2 * channels, 28);
      h.writeUInt16LE(2 * channels, 32);
      h.writeUInt16LE(16, 34);
      h.write("data", 36);
      h.writeUInt32LE(dataSize, 40);
      return Buffer.concat([h, data]);
    };
    for (const wav of [mk(1, 0xffffffff), mk(1, 0), mk(2, 16)]) {
      const r = parseWav(wav);
      expect(r.sampleRate).toBe(22050);
      expect(Array.from({ length: 4 }, (_, i) => r.pcm.readInt16LE(i * 2))).toEqual(samples);
    }
    expect(() => parseWav(Buffer.from("not a wav file at all, definitely not one"))).toThrow();
  });
});

describe("sizing by any dimension", () => {
  const bike = { x: 170, y: 60, z: 100 }; // wide, shallow, medium tall
  it("converts width/length/longest to the proportional height", () => {
    expect(heightForDimension(bike, "height", 50)).toBe(50);
    expect(heightForDimension(bike, "width", 85)).toBeCloseTo(50);
    expect(heightForDimension(bike, "length", 30)).toBeCloseTo(50);
    expect(heightForDimension(bike, "longest", 85)).toBeCloseTo(50);
    expect(heightForDimension({ x: 0, y: 0, z: 0 }, "width", 40)).toBe(40);
  });
});
