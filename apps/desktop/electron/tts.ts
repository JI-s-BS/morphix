// Local text-to-speech fallback (espeak-ng) for when Gemini can't speak, e.g. no
// network. Produces PCM16 that goes to the touchscreen's speaker through the same
// voice "audio" event as Gemini's replies. Installed by scripts/pi/ensure-tts.sh.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Pcm {
  pcm: Buffer;
  sampleRate: number;
}

export function findEspeak(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.MORPHIX_ESPEAK, join(homedir(), ".local/share/morphix-tts/run-espeak"), "/usr/bin/espeak-ng", "/usr/bin/espeak"];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!)) ?? null;
}

/** Extracts mono/stereo 16-bit PCM from a WAV (espeak-ng --stdout writes a streaming WAV with bogus sizes). */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let o = 12;
  let sampleRate = 0, channels = 1, bits = 16;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    let size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16 || !sampleRate) throw new Error(`unsupported WAV (${bits}-bit, ${sampleRate} Hz)`);
      // Streamed WAVs leave size as 0 or 0xffffffff: take the rest of the file.
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      let pcm = buf.subarray(body, body + size - (size % (2 * channels)));
      if (channels > 1) {
        const mono = Buffer.alloc((pcm.length / (2 * channels)) * 2);
        for (let i = 0, j = 0; j < mono.length; i += 2 * channels, j += 2) mono.writeInt16LE(pcm.readInt16LE(i), j);
        pcm = mono;
      }
      return { pcm: Buffer.from(pcm), sampleRate };
    }
    o = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export class LocalTts {
  constructor(private bin: string | null = findEspeak(), private timeoutMs = 15_000) {}

  get available(): boolean {
    return this.bin !== null;
  }

  synthesize(text: string): Promise<Pcm> {
    const bin = this.bin;
    if (!bin) return Promise.reject(new Error("espeak-ng is not installed"));
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        ["--stdout", "-v", "en-us", "-s", "150", "-a", "180", "--", text.slice(0, 600)],
        { encoding: "buffer", timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(new Error(`espeak-ng failed: ${err.message}`));
          try {
            resolve(parseWav(stdout as Buffer));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }
}
