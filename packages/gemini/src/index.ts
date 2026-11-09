// Conversational assistant adapters. Phase 1 ships a scripted demo assistant so
// the push-to-talk flow works end to end without a key. Gemini Live (audio in,
// audio + transcript out, function calls routed through the local policy layer)
// replaces it in Phase 2 behind the same interface.

export interface AssistantReply {
  text: string;
  /** A Meshy prompt the assistant proposes; the app still asks the user to confirm. */
  proposedPrompt?: string;
}

export interface Assistant {
  readonly name: "demo" | "gemini";
  /** Handle a recorded utterance (16-bit PCM mono). */
  hearAudio(pcm16: Buffer, sampleRate: number): Promise<{ transcript: string; reply: AssistantReply }>;
  hearText(text: string): Promise<AssistantReply>;
}

export class GeminiNotConfigured extends Error {
  constructor() {
    super("Gemini is not enabled yet (Phase 2). Add GEMINI_API_KEY and enable it in a later phase.");
  }
}

/** Rough speech detection so the demo can tell silence from talking. */
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

export class DemoAssistant implements Assistant {
  readonly name = "demo" as const;

  async hearAudio(pcm16: Buffer, sampleRate: number) {
    const { seconds, rms, peak } = speechStats(pcm16, sampleRate);
    const heard = rms > 0.01 || peak > 0.1;
    const transcript = heard
      ? `(demo mode: heard ${seconds.toFixed(1)}s of audio — speech-to-text arrives with Gemini in Phase 2)`
      : `(demo mode: ${seconds.toFixed(1)}s recorded but it was nearly silent — check the microphone)`;
    const reply: AssistantReply = heard
      ? {
          text: "I can hear you! In demo mode I can't understand words yet, so tap an idea below or type one, and I'll build a demo model.",
        }
      : { text: "That was very quiet. Hold the microphone button and speak a little closer to the mic." };
    return { transcript, reply };
  }

  async hearText(text: string): Promise<AssistantReply> {
    const t = text.trim();
    if (!t) return { text: "Tell me what you'd like to make." };
    return {
      text: `Got it! In demo mode I'll make a placeholder model for "${t}". With Gemini and Meshy connected this becomes a real generated model.`,
      proposedPrompt: t,
    };
  }
}
export * from "./live";
