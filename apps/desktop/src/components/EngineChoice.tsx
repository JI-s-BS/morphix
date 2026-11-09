// Gemini's "Meshy, Claude or open source?" question as three big buttons. Tapping one answers
// Gemini in words, exactly as if the user had said it; nothing is created from here directly.
import { useEffect, useState } from "react";
import type { EngineChoice as Choice } from "@morphix/shared";
import { api } from "../bridge";

const OPTIONS: { id: Choice["recommended"]; icon: string; name: string; what: string; say: string }[] = [
  { id: "meshy", icon: "🐉", name: "Meshy", what: "Toys, figures, things to hold or look at", say: "Use Meshy" },
  { id: "claude", icon: "📐", name: "Claude", what: "Exact-size parts that fit or work", say: "Use Claude" },
  { id: "open_source", icon: "🌍", name: "Open source", what: "A proven free design", say: "Find an open-source design" },
];

export function EngineChoice({ sendText }: { sendText: (text: string) => Promise<void> }) {
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(
    () =>
      api.onAppEvent((e) => {
        if (e.type === "engine-choice") setChoice(e.choice); // null once the user has picked
      }),
    [],
  );

  if (!choice) return null;
  const pick = (say: string) => {
    setChoice(null);
    void sendText(say);
  };
  return (
    <div className="bubble assistant engine-choice">
      <div className="small">How should I make “{choice.request}”?</div>
      <div className="engine-options">
        {OPTIONS.map((o) => {
          const off = o.id === "claude" && !choice.claudeAvailable;
          return (
            <button key={o.id} className={`btn engine-option ${o.id === choice.recommended ? "primary" : ""}`} disabled={off} onClick={() => pick(o.say)}>
              <span className="engine-icon">{o.icon}</span>
              <b>{o.name}{o.id === choice.recommended ? " ⭐" : ""}</b>
              <span className="small">{off ? "Needs its key first" : o.what}</span>
            </button>
          );
        })}
      </div>
      {choice.reason && <div className="muted small">⭐ Recommended: {choice.reason}</div>}
    </div>
  );
}
