import { useEffect, useState } from "react";
import type { Project } from "@morphix/shared";
import { api } from "../bridge";

const STATE_LABEL: Record<Project["state"], string> = {
  idea: "New idea",
  clarification: "Needs an answer",
  generating: "Generating…",
  reviewing: "Ready to look at",
  sizing: "Picking a size",
  validating: "Checking it",
  slicing: "Getting it ready…",
  approval: "Ready to print",
  uploading: "Sending to printer…",
  ready: "On the printer",
  printing: "Printing…",
  completed: "Printed! 🎉",
  failed: "Didn't work",
};

export function LibraryPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    const load = () => api.listProjects().then(setProjects);
    void load();
    return api.onGenerationProgress((p) => {
      if (p.status === "succeeded" || p.status === "failed") void load();
    });
  }, []);

  if (projects === null) return <div className="empty">Loading library…</div>;
  if (!projects.length)
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>Nothing here yet 🌱</div>
          <div className="muted">Go to Make and tell me what to create!</div>
        </div>
      </div>
    );

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="hero-title">My Things 🧸</h2>
        <span className="muted small">{projects.length} things made</span>
      </div>
      <div className="grid">
        {projects.map((p) => (
          <button key={p.id} className="tile" onClick={() => onOpen(p.id)} disabled={!p.latestVersionId}>
            <div className="thumb">{p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" /> : <span>{p.latestVersionId ? "No preview yet" : "…"}</span>}</div>
            <div className="meta">
              <div className="title">{p.title}</div>
              <div className="muted small">{STATE_LABEL[p.state] ?? p.state} · {new Date(p.createdAt).toLocaleDateString()}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
