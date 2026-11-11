import { useEffect, useState } from "react";
import type { AppSettings, LibraryManifest, ModelVersion, Project } from "@morphix/shared";
import { MM_PER_INCH, fitsBuildVolume } from "@morphix/domain";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import { api } from "../bridge";
import { ModelViewer, type ModelSize } from "../components/ModelViewer";
import { useTheme } from "../theme";

const PRESETS: [string, number][] = [["Tiny 2″", 2 * MM_PER_INCH], ["Small 3″", 3 * MM_PER_INCH], ["Medium 4″", 4 * MM_PER_INCH], ["Big 6″", 6 * MM_PER_INCH]];
const KIND_LABEL: Record<ModelVersion["kind"], string> = { demo: "Demo", preview: "Shape", refine: "Colour" };

interface Props {
  projectId: string | null;
  settings: AppSettings | null;
  heightEvent: { versionId: string; heightMm: number; n: number } | null;
  onBrowse: () => void;
  onPrepare: () => void;
  onError: (message: string) => void;
}

export function ViewerPage({ projectId, settings, heightEvent, onBrowse, onPrepare, onError }: Props) {
  const [data, setData] = useState<{ project: Project; versions: ModelVersion[] } | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [size, setSize] = useState<{ native: ModelSize; scaled: ModelSize } | null>(null);
  const theme = useTheme().resolved;
  const [manifest, setManifest] = useState<LibraryManifest | null>(null);
  const [resizeAnyway, setResizeAnyway] = useState(false);

  const load = (keepVersion = false) => {
    if (!projectId) return;
    api.getProject(projectId).then((d) => {
      setData(d);
      const v = (keepVersion && d?.versions.find((x) => x.id === versionId)) || d?.versions[0];
      setVersionId(v?.id ?? null);
      setHeight(v?.targetHeightMm ?? null);
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [projectId]);
  useEffect(() => {
    setManifest(null);
    setResizeAnyway(false);
    if (versionId) api.libraryManifest(versionId).then(setManifest).catch(() => setManifest(null));
  }, [versionId]);
  useEffect(
    () =>
      api.onGenerationProgress((p) => {
        if (p.projectId === projectId && p.status === "succeeded") load();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );
  useEffect(() => {
    if (heightEvent && heightEvent.versionId === versionId) setHeight(heightEvent.heightMm);
    else if (heightEvent) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightEvent?.n]);

  if (!projectId || !data) {
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>No model open</div>
          <div className="muted" style={{ marginBottom: 12 }}>Pick one from the library.</div>
          <button className="btn primary" onClick={onBrowse}>Open library</button>
        </div>
      </div>
    );
  }

  const v = data.versions.find((x) => x.id === versionId) ?? data.versions[0];
  if (!v) return <div className="empty">This project has no model yet.</div>;

  const setTarget = async (mm: number | null) => {
    setHeight(mm);
    try {
      await api.setTargetHeight(v.id, mm ? Math.round(mm * 10) / 10 : null);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const nudge = (d: number) => setTarget(Math.max(5, Math.round(((height ?? size?.scaled.z ?? 50) + d) * 10) / 10));
  const fits = size ? fitsBuildVolume(size.scaled, QD330_BUILD_VOLUME_MM) : true;
  // Imported designs and Claude CAD parts are made to exact sizes: resizing is opt-in.
  const exactSize = v.source === "library" || v.source === "openscad";
  const fmt = (mm: number) => `${mm.toFixed(1)} mm`;

  return (
    <div className="viewer">
      <div style={{ position: "relative", minHeight: 0, display: "grid" }}>
        <ModelViewer
          key={`${v.id}-${theme}`}
          url={v.url}
          format={v.format}
          targetHeightMm={height}
          onMeasured={(native, scaled) => setSize({ native, scaled })}
          onError={onError}
          onThumbnail={v.thumbnailUrl ? undefined : (png) => void api.saveThumbnail(v.id, png)}
        />
        <div className="overlay">
          {data.versions.length > 1 &&
            data.versions.map((x) => (
              <button key={x.id} className={`chip chip-btn ${x.id === v.id ? "on" : ""}`} onClick={() => { setVersionId(x.id); setHeight(x.targetHeightMm); }}>
                v{x.version} · {KIND_LABEL[x.kind]}
              </button>
            ))}
          {data.versions.length <= 1 && <span className="chip">Drag to rotate · pinch to zoom</span>}
        </div>
      </div>
      <aside className="side">
        <div className="card">
          <h3>{data.project.title}</h3>
          <div className="muted small">v{v.version} · {v.source === "demo" ? "demo model" : v.source === "library" ? `design from ${manifest?.sourceName ?? "a model library"}` : v.source === "openscad" ? "designed by Claude (exact size)" : v.source === "scan" ? "3D scan" : "Meshy model"} · {v.bytes < 100_000 ? `${Math.max(1, Math.round(v.bytes / 1000))} KB` : `${(v.bytes / 1e6).toFixed(1)} MB`}</div>
        </div>
        {manifest && <LibraryPanel manifest={manifest} projectId={data.project.id} onError={onError} onPlate={() => load()} />}
        <div className="card">
          <h3>Size</h3>
          {size ? (
            <>
              <div className="stat"><span className="muted">Width</span><span>{fmt(size.scaled.x)}</span></div>
              <div className="stat"><span className="muted">Depth</span><span>{fmt(size.scaled.y)}</span></div>
              <div className="stat"><span className="muted">Height</span><span>{fmt(size.scaled.z)} · {(size.scaled.z / MM_PER_INCH).toFixed(2)} in</span></div>
              <div className="stat">
                <span className="muted">Fits the printer?</span>
                <span style={{ color: fits ? "var(--ok)" : "var(--bad)", fontWeight: 800 }}>{fits ? "Fits! ✅" : "Too big ❌"}</span>
              </div>
            </>
          ) : (
            <div className="muted">Measuring…</div>
          )}
        </div>
        {exactSize && !resizeAnyway ? (
          <div className="card">
            <h3>Size 📏</h3>
            <div className="small">This design is made to exact sizes (to fit a device, bearings, screws or its other parts), so it prints at its original size.</div>
            <button className="btn ghost" style={{ marginTop: 6, minHeight: 40 }} onClick={() => setResizeAnyway(true)}>Resize anyway</button>
          </div>
        ) : (
        <div className="card">
          <h3>How big? 📏</h3>
          {exactSize && <div className="small" style={{ color: "var(--warn)", marginBottom: 6 }}>⚠️ Resizing can stop parts fitting together or fitting what they were made for.</div>}
          <div className="size-grid">
            {PRESETS.map(([label, mm]) => (
              <button key={label} className={`btn ${height && Math.abs(height - mm) < 0.5 ? "primary" : ""}`} onClick={() => void setTarget(mm)}>{label}</button>
            ))}
            <button className="btn" onClick={() => void nudge(-5)}>− 5 mm</button>
            <button className="btn" onClick={() => void nudge(5)}>+ 5 mm</button>
            {(v.source === "demo" || v.source === "library" || v.source === "openscad") && (
              <button className="btn ghost" style={{ gridColumn: "1 / -1" }} onClick={() => setTarget(null)}>Original size</button>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>Or just say “make it six inches tall”.</div>
        </div>
        )}
        <button className="btn primary" style={{ width: "100%", flex: "none" }} disabled={!fits} onClick={onPrepare}>Get it ready to print 🖨️</button>
      </aside>
    </div>
  );
}

/** Where an imported design came from, its parts and plates, hardware and assembly. */
function LibraryPanel({ manifest: m, projectId, onError, onPlate }: { manifest: LibraryManifest; projectId: string; onError: (e: string) => void; onPlate: () => void }) {
  return (
    <div className="card">
      <h3>📦 From {m.sourceName}</h3>
      {m.source ? <div className="small">{m.creator ? `by ${m.creator} · ` : ""}{m.license ? `${m.license}${m.licenseVerified ? " ✓" : " (as listed — check the page)"}` : "Licence: check the page"}</div> : <div className="small">Imported from a file on your device, at its own size.</div>}
      <div className="muted small" style={{ wordBreak: "break-all" }}>{m.source}</div>
      <div className="field-label" style={{ marginTop: 6 }}>Printed parts ({m.parts.length})</div>
      {m.parts.map((p) => (
        <div key={p.name} className="stat">
          <span className="small">{p.name}</span>
          <span className="small" style={{ color: p.fits ? undefined : "var(--bad)" }}>{p.sizeMm.x}×{p.sizeMm.y}×{p.sizeMm.z} mm{p.fits ? (m.plates.length > 1 && p.plate ? ` · plate ${p.plate}` : "") : " · too big"}</span>
        </div>
      ))}
      {m.plates.length > 1 && (
        <>
          <div className="field-label" style={{ marginTop: 6 }}>Build plates</div>
          <div className="seg" style={{ flexWrap: "wrap" }}>
            {m.plates.map((parts, i) => (
              <button key={i} className={m.currentPlate === i + 1 ? "on" : ""} title={parts.join(", ")}
                onClick={() => void api.libraryPlate(projectId, i + 1).then(onPlate).catch((e) => onError((e as Error).message))}>Plate {i + 1}</button>
            ))}
          </div>
          <div className="muted small">Showing plate {m.currentPlate}: {m.plates[m.currentPlate - 1]?.join(", ")}</div>
        </>
      )}
      {m.nonPrintedParts.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Also needs (not printed):</b> {m.nonPrintedParts.join(", ")}</div>}
      {m.assembly.length > 0 && (
        <>
          <div className="field-label" style={{ marginTop: 6 }}>How to put it together</div>
          <ol className="small" style={{ margin: "2px 0 0", paddingLeft: 18 }}>{m.assembly.map((a, i) => <li key={i}>{a}</li>)}</ol>
        </>
      )}
      {m.source ? <div className="muted small" style={{ marginTop: 6 }}>{m.evidence.length ? `Printed by others: ${m.evidence.join("; ")}` : "No print reports found — it hasn't been shown to work yet."}</div> : null}
      {m.warnings.map((w) => <div key={w} className="small warn-line" style={{ color: "var(--warn)" }}>⚠ {w}</div>)}
      {m.preserved.length > 0 && <div className="muted small">Kept with the project: {m.preserved.join(", ")}</div>}
    </div>
  );
}
