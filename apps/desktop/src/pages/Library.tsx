import { useEffect, useRef, useState } from "react";
import type { Project } from "@morphix/shared";
import { api } from "../bridge";
import { friendlyError } from "../errors";

const MAX_IMPORT_BYTES = 100_000_000;

/** "Import a file": STL / 3MF / OBJ / PLY / GLB from this device. Opens the new model when done. */
function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = [...list];
    if (chosen.reduce((t, f) => t + f.size, 0) > MAX_IMPORT_BYTES) {
      setNote("Those files are too big together (100 MB at most).");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const files = await Promise.all(chosen.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
      const r = await api.importModelFiles(files);
      if (r.warnings.length) setNote(r.warnings.join(" "));
    } catch (e) {
      setNote(friendlyError(e).title);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Importing…" : "📂 Import a file"}</button>
      <input ref={input} type="file" multiple accept=".stl,.3mf,.obj,.ply,.glb" hidden onChange={(e) => void pick(e.target.files)} aria-label="Model files to import" />
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

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
          <div className="muted">Go to Make and tell me what to create, or import a model file you already have.</div>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}><ImportButton /></div>
        </div>
      </div>
    );

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="hero-title">My Things 🧸</h2>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <ImportButton />
          <span className="muted small">{projects.length} things made</span>
        </div>
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
