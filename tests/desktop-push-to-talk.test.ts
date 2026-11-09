// Hold-to-talk on the Pi: getUserMedia + AudioWorklet loading take a noticeable moment. Releasing
// during that moment used to close the AudioContext mid-addModule ("Microphone unavailable: Unable
// to load a worklet's module", seen in the Pi log 2026-11-08) or leave the mic recording forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushToTalk } from "../apps/desktop/src/audio";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

let moduleLoad: Deferred;
let contexts: FakeContext[];
let tracksStopped = 0;

class FakeContext {
  sampleRate = 48000;
  closed = false;
  destination = {};
  audioWorklet = {
    addModule: () => moduleLoad.promise.then(() => {
      if (this.closed) throw new Error("Unable to load a worklet's module.");
    }),
  };
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect: (n: unknown) => n };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (n: unknown) => n };
  }
  async close() {
    this.closed = true;
  }
}

beforeEach(() => {
  moduleLoad = deferred();
  contexts = [];
  tracksStopped = 0;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracksStopped++ }] }) },
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port: { onmessage: unknown } = { onmessage: null };
      connect(n: unknown) {
        return n;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("PushToTalk", () => {
  it("a release while the worklet is still loading waits for it and closes cleanly", async () => {
    const p = new PushToTalk();
    const started = p.start();
    await Promise.resolve();
    expect(p.active).toBe(true);
    const stopped = p.stop();
    moduleLoad.resolve();
    await expect(started).resolves.toBeUndefined();
    const rec = await stopped;
    expect(rec.seconds).toBe(0);
    expect(p.active).toBe(false);
    expect(p.recording).toBe(false);
    expect(contexts.every((c) => c.closed)).toBe(true);
    expect(tracksStopped).toBe(1);
  });

  it("a second press while starting doesn't open a second microphone", async () => {
    const p = new PushToTalk();
    const a = p.start();
    const b = p.start();
    moduleLoad.resolve();
    await Promise.all([a, b]);
    expect(contexts).toHaveLength(1);
    expect(p.recording).toBe(true);
    await p.stop();
    expect(p.active).toBe(false);
  });

  it("a failed start releases the mic and a pending release doesn't throw", async () => {
    const p = new PushToTalk();
    const started = p.start();
    await Promise.resolve();
    const stopped = p.stop();
    moduleLoad.reject(new Error("no worklet"));
    await expect(started).rejects.toThrow("no worklet");
    await expect(stopped).resolves.toMatchObject({ seconds: 0 });
    expect(tracksStopped).toBe(1);
    expect(p.active).toBe(false);
  });
});
