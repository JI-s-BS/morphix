import { useEffect, useRef, useState } from "react";
import type { AppSettings, GenerationProgress } from "@morphix/shared";
import { api } from "../bridge";
import { MicButton, voiceLabel, type Voice } from "../App";
import { TextEntry } from "../components/Keyboard";
import { SearchResults } from "../components/SearchResults";
import { EngineChoice } from "../components/EngineChoice";
import { ClaudeDesignPanel } from "../components/ClaudeDesign";

interface Props {
  voice: Voice;
  settings: AppSettings | null;
  onOpenProject: (id: string) => void;
  onError: (message: string) => void;
}

export function AssistantPage({ voice, settings, onOpenProject, onError }: Props) {
  const [gen, setGen] = useState<GenerationProgress | null>(null);
  const [typing, setTyping] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => api.onGenerationProgress(setGen), []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [voice.turns, voice.userDraft, voice.assistantDraft, voice.proposal, gen]);

  const generating = gen && (gen.status === "queued" || gen.status === "running");
  const meshy = settings?.ai.generator === "meshy";

  return (
    <div className="assistant-page">
      <section className="card mic-panel">
        <MicButton voice={voice} big />
        <div style={{ fontWeight: 650, fontSize: 18 }}>{voiceLabel(voice.state)}</div>
        <div className="muted small">{voice.live ? "Tell me what to make — like “a dragon holding a shield”." : "A grown-up needs to add the Gemini key first."}</div>
        {!meshy && <div className="muted small">The Meshy key is missing too.</div>}
      </section>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
        <h2 className="hero-title">Let’s make something! ✨</h2>
        <div className="transcript" ref={listRef}>
          {voice.turns.length === 0 && !voice.userDraft && (
            <div className="muted">Hold the big button and tell me what you want to make. Or tap an idea below!</div>
          )}
          {voice.turns.map((t) => (
            <div key={t.id} className={`bubble ${t.role}`}>
              {t.text}
              {t.audioUrl && (
                <div>
                  <button className="btn ghost" style={{ minHeight: 38, fontSize: 14 }} onClick={() => new Audio(t.audioUrl).play().catch((e) => onError(String(e)))}>
                    ▶ Hear it
                  </button>
                </div>
              )}
            </div>
          ))}
          {voice.userDraft && <div className="bubble user draft">{voice.userDraft}</div>}
          {voice.assistantDraft && <div className="bubble assistant draft">{voice.assistantDraft}</div>}
          {gen && (
            <div className="bubble assistant gen-card">
              <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
                {gen.thumbnailUrl && <img className="gen-thumb" src={gen.thumbnailUrl} alt="" />}
                <div style={{ flex: 1 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>{gen.stage}</span>
                    <span className="muted small">{gen.progress}%</span>
                  </div>
                  <div className="progress" style={{ marginTop: 8 }}><div style={{ width: `${gen.progress}%` }} /></div>
                  {gen.status === "succeeded" && (
                    <button className="btn primary" style={{ marginTop: 10 }} onClick={() => onOpenProject(gen.projectId)}>Look at it! 👀</button>
                  )}
                  {gen.status === "failed" && <div style={{ color: "var(--bad)", marginTop: 8 }}>{gen.error}</div>}
                </div>
              </div>
            </div>
          )}
          <EngineChoice sendText={voice.sendText} />
          <ClaudeDesignPanel onOpenProject={onOpenProject} />
          <SearchResults onOpenProject={onOpenProject} onError={onError} />
        </div>
        <div className="chips">
          <button className="btn" onClick={() => setTyping(true)}>⌨️ Type it</button>
        </div>
      </section>
      {typing && (
        <TextEntry
          title="What should I make?"
          hint="e.g. a dragon figurine holding a shield"
          submitLabel="Send"
          onCancel={() => setTyping(false)}
          onSubmit={(text) => {
            setTyping(false);
            void voice.sendText(text);
          }}
        />
      )}
    </div>
  );
}
