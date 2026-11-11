// Gemini Live voice assistant (audio in, audio + transcript out, function calls routed
// through the local policy layer in apps/desktop/electron/voice.ts).

/** Rough speech detection: tells silence from talking before audio is sent. */
export function speechStats(pcm16: Buffer, sampleRate: number): { seconds: number; rms: number; peak: number } {
  const n = Math.floor(pcm16.length / 2);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * 2) / 32768;
    sum += s * s;
    peak = Math.max(peak, Math.abs(s));
  }
  return { seconds: n / sampleRate, rms: n ? Math.sqrt(sum / n) : 0, peak };
}

export * from "./live";
