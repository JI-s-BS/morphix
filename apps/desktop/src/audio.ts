// Push-to-talk capture: microphone -> AudioWorklet -> 16 kHz mono 16-bit PCM
// (the format Gemini Live expects in Phase 2).
export const TARGET_RATE = 16000;

export class PushToTalk {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  /** Set while getUserMedia/addModule run; a release then waits for it instead of closing mid-load. */
  private starting: Promise<void> | null = null;
  private stopping = false;

  constructor(private onLevel: (level: number) => void = () => {}) {}

  /** True from the press until stop() finishes, including while the mic is still starting. */
  get active(): boolean {
    return this.ctx !== null || this.starting !== null;
  }

  /** True only while audio is actually being captured and no release is pending. */
  get recording(): boolean {
    return this.ctx !== null && this.starting === null && !this.stopping;
  }

  start(): Promise<void> {
    if (this.active) return this.starting ?? Promise.resolve();
    this.chunks = [];
    this.stopping = false;
    const run = this.open().finally(() => {
      this.starting = null;
    });
    this.starting = run;
    return run;
  }

  private async open(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext();
    try {
      await ctx.audioWorklet.addModule("./pcm-recorder.worklet.js");
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => undefined);
      throw e;
    }
    this.stream = stream;
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-recorder");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(e.data);
      let peak = 0;
      for (const s of e.data) peak = Math.max(peak, Math.abs(s));
      this.onLevel(Math.min(1, peak * 2));
    };
    // The worklet must be pulled by the destination to run; route it through a muted gain.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
  }

  async stop(): Promise<{ pcm: ArrayBuffer; sampleRate: number; seconds: number }> {
    if (this.starting) {
      // Released before the mic was ready (slow on the Pi): let start finish, then close cleanly.
      this.stopping = true;
      await this.starting.catch(() => undefined); // start() reports its own failure
      if (!this.ctx) return { pcm: new ArrayBuffer(0), sampleRate: TARGET_RATE, seconds: 0 };
    }
    const ctx = this.ctx;
    if (!ctx) throw new Error("not recording");
    const rate = ctx.sampleRate;
    this.stream?.getTracks().forEach((t) => t.stop());
    await ctx.close();
    this.ctx = null;
    this.stream = null;
    this.onLevel(0);
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const pcm = toPcm16(downsample(all, rate, TARGET_RATE));
    return { pcm: pcm.buffer as ArrayBuffer, sampleRate: TARGET_RATE, seconds: pcm.length / TARGET_RATE };
  }
}

export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function toPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Short two-tone chime to check the speaker. */
export async function speakerTest(): Promise<void> {
  const ctx = new AudioContext();
  const t = ctx.currentTime;
  for (const [freq, at] of [[660, 0], [880, 0.18]] as const) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
    osc.connect(g).connect(ctx.destination);
    osc.start(t + at);
    osc.stop(t + at + 0.32);
  }
  await new Promise((r) => setTimeout(r, 700));
  await ctx.close();
}

/** Three rising beeps before a spoken Print Guardian warning. Never throws. */
export async function alertChime(): Promise<void> {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const t = ctx.currentTime;
    for (const [freq, at] of [[784, 0], [988, 0.2], [1319, 0.4]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.45, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.18);
      osc.connect(g).connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.2);
    }
    await new Promise((r) => setTimeout(r, 700));
  } catch {
    /* no audio device: the alert is still on screen */
  } finally {
    void ctx?.close().catch(() => {});
  }
}

/**
 * Seconds of audio queued before Gemini's voice starts (and again after an underrun). Chunks
 * arrive unevenly over Wi-Fi and while the Pi is busy slicing or rendering; with only 50 ms of
 * lead a late chunk was heard as the voice cutting out.
 */
export const PLAYBACK_LEAD_S = 0.3;

/** Plays streamed 16-bit PCM (Gemini speaks at 24 kHz) gap-free through the speaker. */
export class AudioOut {
  private ctx: AudioContext | null = null;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /** Called when audio devices change (e.g. the USB speaker was unplugged/replugged). */
  reset(): void {
    this.stop();
    const old = this.ctx;
    this.ctx = null;
    void old?.close().catch(() => {});
  }

  play(pcm: ArrayBuffer, sampleRate: number): void {
    if (this.ctx?.state === "closed") this.ctx = null;
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const ints = new Int16Array(pcm);
    if (!ints.length) return;
    const buf = ctx.createBuffer(1, ints.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ints.length; i++) ch[i] = ints[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    // Queue ran dry (start of a reply, or a late chunk): buffer a little before playing on.
    if (this.next < ctx.currentTime + 0.02) this.next = ctx.currentTime + PLAYBACK_LEAD_S;
    src.start(this.next);
    this.next += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Stop immediately (user started talking or Gemini was interrupted). */
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.next = 0;
  }
}
