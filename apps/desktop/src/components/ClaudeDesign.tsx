// Claude designing a part, live on the Make page: which step it's on, the attempt, the
// OpenSCAD it just wrote, and a 3D preview of each rendered attempt. The latest design is
// kept outside React so it survives switching pages.
import { useEffect, useRef, useState } from "react";
import type { ClaudeDesignView } from "@morphix/shared";
import { api } from "../bridge";
import { ModelViewer } from "./ModelViewer";

let latest: { design: ClaudeDesignView; at: number } | null = null;
const listeners = new Set<(d: typeof latest) => void>();
let watching = false;

/** Call once at app start so no update is missed while another page is open. */
export function watchClaudeDesigns(): void {
  if (watching) return;
  watching = true;
  api.onAppEvent((e) => {
    if (e.type !== "claude-design") return;
    latest = { design: e.design, at: Date.now() };
    for (const l of listeners) l(latest);
  });
}

const STEPS: { key: string; label: string }[] = [
  { key: "designing", label: "🧠 Thinking & writing CAD" },
  { key: "rendering", label: "🛠️ Building the shape" },
  { key: "checking", label: "🔍 Checking it fits" },
  { key: "done", label: "✅ Done" },
];
/** Shown for this long after Claude finishes, then the panel tidies itself away. */
const KEEP_FINISHED_MS = 5 * 60_000;

export function ClaudeDesignPanel({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  watchClaudeDesigns();
  const [state, setState] = useState(latest);
  const [, tick] = useState(0);
  const code = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    listeners.add(setState);
    const t = window.setInterval(() => tick((n) => n + 1), 1000); // elapsed time
    return () => {
      listeners.delete(setState);
      window.clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (code.current) code.current.scrollTop = code.current.scrollHeight;
  }, [state?.design.scad]);

  if (!state) return null;
  const d = state.design;
  if (d.status !== "working" && Date.now() - state.at > KEEP_FINISHED_MS) return null;
  const working = d.status === "working";
  const stepKey = d.status === "done" ? "done" : d.stage === "repairing" ? "designing" : d.stage;
  const current = STEPS.findIndex((s) => s.key === stepKey);
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(d.startedAt)) / 1000));
  const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const title = working ? `📐 Claude is designing “${d.title}”` : d.status === "done" ? `✅ Claude finished “${d.title}”` : d.status === "stopped" ? `⏹️ Stopped “${d.title}”` : `😟 Claude couldn't finish “${d.title}”`;

  return (
    <div className={`bubble assistant claude-design ${d.status}`}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <b>{title}</b>
        <span className="muted small">{working ? elapsed : ""}</span>
      </div>
      <div className="claude-steps">
        {STEPS.map((s, i) => (
          <span key={s.key} className={`claude-step ${i < current ? "past" : i === current ? (working ? "now" : d.status === "done" ? "past" : "bad") : ""}`}>{s.label}</span>
        ))}
      </div>
      <div className="small claude-detail">
        {d.attempt > 1 || d.stage === "repairing" ? <b>Attempt {d.attempt} of {d.maxAttempts}: </b> : null}
        {d.stage === "repairing" && working ? `fixing — ${d.detail}` : d.detail}
      </div>
      {(d.previewUrl || d.scad) && (
        <div className="claude-live">
          <div className="claude-preview">
            {d.previewUrl ? (
              <ModelViewer key={d.previewUrl} url={d.previewUrl} format="stl" targetHeightMm={null} />
            ) : (
              <div className="claude-preview-wait">{working ? "The 3D preview appears after the first build…" : "No preview"}</div>
            )}
          </div>
          {d.scad && (
            <pre ref={code} className="claude-code" aria-label="OpenSCAD code Claude wrote">{d.scad.split("\n").slice(-60).join("\n")}</pre>
          )}
        </div>
      )}
      {d.status === "done" && d.projectId && (
        <button className="btn primary" style={{ marginTop: 8 }} onClick={() => onOpenProject(d.projectId!)}>Look at it! 👀</button>
      )}
    </div>
  );
}
