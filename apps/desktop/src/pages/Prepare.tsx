import { useEffect, useState } from "react";
import { QD330_MAX_SPEED_MMS, type SlicerDefaults, type ModelVersion, type PrepareSummary, type PrintControlStatus, type Project, type FilamentState, type PrinterStatus } from "@morphix/shared";
import { api } from "../bridge";

// Filament chips size to their label and wrap to a new row instead of squashing long names.
const CHIP = { flex: "1 0 auto" } as const;
const SPEED_CHIPS = [60, 150, 300, QD330_MAX_SPEED_MMS];
const SPEED_KEY = "morphix.printSpeed.v1";
const Z_KEY = "morphix.zOffset.v1";
/** Remembered Z offset (mm) or null for the printer profile's. */
function savedZ(): number | null {
  try {
    const v = localStorage.getItem(Z_KEY);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n >= -0.5 && n <= 1 ? n : null;
  } catch {
    return null;
  }
}
/** Remembered speed (mm/s) or null for the profile's normal speeds. */
function savedSpeed(): number | null {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY));
    return n >= 20 && n <= QD330_MAX_SPEED_MMS ? n : null;
  } catch {
    return null;
  }
}
const STAGES: Record<string, string> = {
  load: "Opening your model 📦", validate: "Checking it for holes 🔍", repair: "Fixing little problems 🔧", place: "Finding the best way to stand it up 🧍",
  advise: "Picking the best settings 🤖",
  slice: "Cutting it into layers 🍰 (this can take a few minutes)", gx: "Writing the printer file 📝", done: "All done! 🎉",
};

const duration = (s: number | null | undefined) => {
  if (!s) return "–";
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};

interface Props {
  projectId: string | null;
  onBack: () => void;
  onError: (m: string) => void;
  status: PrinterStatus | null;
}

export function PreparePage({ projectId, status, onBack, onError }: Props) {
  const [data, setData] = useState<{ project: Project; versions: ModelVersion[] } | null>(null);
  const [summary, setSummary] = useState<PrepareSummary | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [control, setControl] = useState<PrintControlStatus | null>(null);
  const [filaments, setFilaments] = useState<FilamentState | null>(null);
  // Nozzle height above the bed for this print; null = the printer profile's.
  const [zOffset, setZState] = useState<number | null>(savedZ);
  const [defaults, setDefaults] = useState<SlicerDefaults | null>(null);
  const setZ = (n: number | null) => {
    setZState(n);
    try {
      if (n === null) localStorage.removeItem(Z_KEY);
      else localStorage.setItem(Z_KEY, String(n));
    } catch {
      /* remembered value is only a convenience */
    }
  };
  // One speed for every layer (no slow first layers), up to the printer's maximum; null = normal.
  const [speed, setSpeedState] = useState<number | null>(savedSpeed);
  const setSpeed = (n: number | null) => {
    setSpeedState(n);
    try {
      if (n) localStorage.setItem(SPEED_KEY, String(n));
      else localStorage.removeItem(SPEED_KEY);
    } catch {
      /* remembered speed is only a convenience */
    }
  };

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setData);
    api.latestPrintJob(projectId).then((s) => {
      if (s) setSummary(s);
    });
    api.printStatus().then(setControl);
    api.filaments().then(setFilaments).catch(() => {});
    api.slicerDefaults().then(setDefaults).catch(() => {});
    return api.onAppEvent((e) => {
      if (e.type === "prepare-progress") setStage(e.stage);
      if (e.type === "print-status") setControl(e.status);
    });
  }, [projectId]);

  if (!projectId || !data) return <div className="empty">Open a model first, then tap “Prepare to print”.</div>;
  const v = data.versions[0];
  if (!v) return <div className="empty">This project has no model yet.</div>;

  const run = async () => {
    setStage("load");
    setSummary(null);
    try {
      // The touchscreen always uses the agent slicer; only the filament is the user's choice.
      setSummary(await api.preparePrint(v.id, "auto", { ...(speed ? { speedMmS: speed } : {}), ...(zOffset !== null ? { zOffsetMm: zOffset } : {}) }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setStage(null);
    }
  };
  const print = () => summary && api.requestPrint(summary.jobId).catch((e) => onError((e as Error).message));
  const busy = stage !== null;
  const est = summary?.estimates;
  const loadedLabel = filaments?.list.find((f) => f.id === filaments.loaded)?.label;
  const slicedLabel = filaments?.list.find((f) => f.id === summary?.settings.filament)?.label ?? summary?.settings.filament;
  const activeJob = control?.job && !["idle", "completed", "cancelled", "failed"].includes(control.job.phase) ? control.job : null;
  // Every reason this can't be printed right now, in plain words.
  const blockers: string[] = [];
  if (summary) {
    if (summary.fits === false) {
      const sz = summary.size ? `${summary.size.x.toFixed(0)} × ${summary.size.y.toFixed(0)} × ${summary.size.z.toFixed(0)} mm` : "too big";
      blockers.push(`It's too big (${sz}). The printer fits 220 × 220 × 220 mm — pick a smaller size on the model page.`);
    }
    if (!summary.slicer.ok) blockers.push(`The slicer couldn't cut it into layers: ${summary.slicer.message ?? summary.slicer.reason ?? "unknown problem"}.`);
    else if (!summary.gx.ok) blockers.push(`Couldn't make the printer file: ${summary.gx.reason ?? "unknown problem"}.`);
    if (summary.error && summary.slicer.ok && summary.fits !== false) blockers.push(summary.error);
    if (!control?.enabled) blockers.push("Printer control is switched off. A grown-up turns it on with MORPHIX_PRINT_CONTROLS=1.");
    else if (summary.gx.ok && !summary.gx.verified && !control.gxVerified) blockers.push("The printer-file format hasn't been checked yet (MORPHIX_GX_VERIFIED=1).");
    if (!status?.online) blockers.push("The printer isn't answering — check it's switched on and its cable is plugged in.");
    else if (activeJob) blockers.push(`The printer is busy (${activeJob.phase}) — wait for it to finish, or end it on the Printer tab.`);
    else if (status.machine && status.machine !== "READY") blockers.push(`The printer isn't ready (it says ${status.machine}).`);
    if (filaments && summary.settings.filament && summary.settings.filament !== filaments.loaded) {
      blockers.push(`It was prepared for ${slicedLabel}, but ${loadedLabel} is in the printer — tap Try again, or load ${slicedLabel} on the Control tab.`);
    }
  }
  const friendly = (w: string): string | null => {
    let m: RegExpExecArray | null;
    if (/\.gx layout is UNVERIFIED/i.test(w)) return control?.gxVerified ? null : "The printer-file format hasn't been checked against Afinia's own files yet.";
    if ((m = /(\d+) open \(boundary\) edges/i.exec(w))) return `The model has ${m[1]} small gaps in its surface — the slicer usually patches these.`;
    if ((m = /(\d+) non-manifold edges/i.exec(w))) return `${m[1]} spots where the surface overlaps itself — usually fine to print.`;
    if (/not watertight after repair/i.test(w)) return "A few gaps couldn't be closed completely; the slicer will try to fix them.";
    return w;
  };
  const headsUp = [...new Set([...(summary?.issues ?? []), ...(summary?.warnings ?? []), ...(summary?.advice?.warnings ?? [])].map(friendly).filter((x): x is string => Boolean(x)))];

  return (
    <div className="prepare">
      <section className="card prep-settings">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>How should it print?</h3>
          <button className="btn ghost" style={{ minHeight: 40 }} onClick={onBack}>‹ Back</button>
        </div>
        <div className="muted small">{data.project.title} · v{v.version} · target height {v.targetHeightMm ? `${v.targetHeightMm.toFixed(0)} mm` : "original"}</div>
        <div className="field-label">Filament in the printer</div>
        <div className="seg" style={{ flexWrap: "wrap" }}>
          {filaments?.list.map((f) => (
            <button key={f.id} className={filaments.loaded === f.id ? "on" : ""} disabled={busy} style={CHIP}
              onClick={() => void api.setLoadedFilament(f.id).then(setFilaments).catch((e) => onError((e as Error).message))}>{f.label}</button>
          ))}
        </div>
        {(() => {
          const f = filaments?.list.find((x) => x.id === filaments.loaded);
          return f ? <div className="muted small">{f.blurb} Nozzle {f.nozzleC} °C · bed {f.bedC} °C.</div> : null;
        })()}
        <div className="field-label">Speed</div>
        <div className="seg">
          <button className={speed === null ? "on" : ""} disabled={busy} onClick={() => setSpeed(null)}>🤖 Normal</button>
          <button className={speed !== null ? "on" : ""} disabled={busy} onClick={() => setSpeed(speed ?? 150)}>⚡ My speed</button>
        </div>
        {speed !== null && (
          <div className="speed-pick">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <b className="speed-value">{speed} mm/s</b>
              <span className="muted small">max {QD330_MAX_SPEED_MMS} mm/s</span>
            </div>
            <input type="range" className="speed-slider" min={20} max={QD330_MAX_SPEED_MMS} step={10} value={speed} disabled={busy}
              aria-label="Print speed in millimetres per second" onChange={(e) => setSpeed(Number(e.target.value))} />
            <div className="seg">
              {SPEED_CHIPS.map((n) => (
                <button key={n} className={speed === n ? "on" : ""} disabled={busy} onClick={() => setSpeed(n)}>{n === QD330_MAX_SPEED_MMS ? `Max ${n}` : n}</button>
              ))}
            </div>
            {(() => {
              const f = filaments?.list.find((x) => x.id === filaments.loaded);
              const layer = summary?.settings.layerHeightMm ?? 0.2;
              const limit = f?.maxVolumetricMm3S ? Math.min(QD330_MAX_SPEED_MMS, Math.round(f.maxVolumetricMm3S / (layer * 0.45))) : QD330_MAX_SPEED_MMS;
              return (
                <div className="muted small">
                  So it sticks to the smooth PEI plate, layer 1 always prints at 20 mm/s and layer 2 at 30 mm/s (moving between at most 100 mm/s) with the cooling fan off; the rest at this speed.
                  {limit < speed ? ` ${f?.label ?? "This filament"} can only melt fast enough for about ${limit} mm/s at ${layer} mm layers, so the slicer will hold it there.` : ""}
                </div>
              );
            })()}
          </div>
        )}
        <div className="field-label">Height above the bed (Z offset)</div>
        {(() => {
          const normal = defaults?.zOffsetMm ?? 0;
          const min = defaults?.minZOffsetMm ?? -0.5;
          const max = defaults?.maxZOffsetMm ?? 1;
          const shown = zOffset ?? normal;
          const step = (d: number) => setZ(Math.round(Math.min(max, Math.max(min, shown + d)) * 100) / 100);
          return (
            <>
              <div className="row z-offset" style={{ alignItems: "center", gap: 8 }}>
                <button className="btn" disabled={busy || shown <= min} onClick={() => step(-0.05)} aria-label="Lower the nozzle 0.05 mm">− 0.05</button>
                <b className="z-value">{shown > 0 ? "+" : ""}{shown.toFixed(2)} mm</b>
                <button className="btn" disabled={busy || shown >= max} onClick={() => step(0.05)} aria-label="Raise the nozzle 0.05 mm">+ 0.05</button>
                {zOffset !== null && zOffset !== normal && (
                  <button className="btn ghost" disabled={busy} onClick={() => setZ(null)}>Normal ({normal.toFixed(2)})</button>
                )}
              </div>
              <div className="muted small">Raise it if the first layer gets squashed into the bed; lower it if the print doesn't stick.</div>
              {shown < 0 && shown < normal && <div className="small" style={{ color: "var(--warn)" }}>⚠️ The nozzle starts lower than normal — too low and it scrapes the bed. Go down a little at a time.</div>}
            </>
          );
        })()}
        {summary && ((summary.settings.speedMmS ?? null) !== speed || (summary.settings.zOffsetMm ?? null) !== zOffset) && (
          <div className="small" style={{ color: "var(--warn)" }}>Settings changed — tap Try again to use them.</div>
        )}
        <div className="muted small" style={{ marginTop: 4 }}>
          🤖 Uses the agent slicer: it picks the slicer, layers, strength and supports for your model.
        </div>
        <button className="btn primary" style={{ marginTop: "auto" }} disabled={busy} onClick={() => void run()}>
          {busy ? STAGES[stage!] ?? "Working…" : summary ? "Try again 🔁" : "Get it ready ✨"}
        </button>
      </section>

      <section className="card prep-result">
        <h3>What I found</h3>
        {!summary && !busy && <div className="muted">Tap “Get it ready” and I’ll check your model, fix small problems, stand it up the best way and cut it into layers for the printer.</div>}
        {busy && (
          <div>
            <div style={{ fontWeight: 600 }}>{STAGES[stage!] ?? stage}</div>
            <div className="progress" style={{ marginTop: 10 }}><div style={{ width: `${(Object.keys(STAGES).indexOf(stage!) + 1) * 14}%` }} /></div>
          </div>
        )}
        {summary && (
          <>
            {blockers.length > 0 && (
              <div className="alert-box" style={{ borderColor: "var(--bad)", marginBottom: 8 }}>
                <div style={{ fontWeight: 800, color: "var(--bad)" }}>Can't print yet — here's why:</div>
                <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                {summary.errorCode && <div className="muted small" style={{ marginTop: 4 }}>Error code {summary.errorCode}</div>}
              </div>
            )}
            {summary.advice && (
              <div className="advice">
                <div style={{ fontWeight: 800 }}>🤖 The AI chose: {summary.advice.layerHeightMm} mm layers · {summary.advice.infillPercent}% inside · supports {summary.advice.supports}{summary.advice.brim ? " · brim" : ""}{summary.advice.slicer ? ` · ${summary.advice.slicer}` : ""}</div>
                <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{summary.advice.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            <div className="result-grid">
              <div className="stat-tile"><div className="k">Size</div><div className="v">{summary.size ? `${summary.size.x.toFixed(0)}×${summary.size.y.toFixed(0)}×${summary.size.z.toFixed(0)}` : "–"}<small> mm</small></div></div>
              <div className="stat-tile"><div className="k">Fits?</div><div className="v" style={{ color: summary.fits ? "var(--ok)" : "var(--bad)" }}>{summary.fits === undefined ? "–" : summary.fits ? "Yes ✅" : "No ❌"}</div></div>
              <div className="stat-tile"><div className="k">Print time</div><div className="v">{duration(est?.printTimeS)}</div></div>
              <div className="stat-tile"><div className="k">Filament</div><div className="v">{est?.filamentG ? `${est.filamentG.toFixed(0)}` : "–"}<small> g</small></div></div>
            </div>
            {est?.source === "mesh-heuristic" && <div className="muted small">Time and filament are rough guesses from the model volume (no slicer run).</div>}
            <div className="stat"><span className="muted">Slicer</span><span style={{ color: summary.slicer.ok ? "var(--ok)" : "var(--warn)" }}>{summary.slicer.ok ? (summary.slicer.name ?? "OK") : summary.slicer.message ?? summary.slicer.reason}</span></div>
            <div className="stat"><span className="muted">Layers</span><span>{est?.layerCount ?? "–"}</span></div>
            <div className="stat"><span className="muted">Z offset</span><span>{(summary.settings.zOffsetMm ?? defaults?.zOffsetMm ?? 0).toFixed(2)} mm{summary.settings.zOffsetMm === undefined ? " (normal)" : ""}</span></div>
            <div className="stat"><span className="muted">Speed</span><span>{summary.settings.speedMmS ? `${summary.settings.speedMmS} mm/s, every layer` : "Normal"}</span></div>
            {summary.settings.filament && (() => {
              const f = filaments?.list.find((x) => x.id === summary.settings.filament);
              const other = filaments && summary.settings.filament !== filaments.loaded;
              return (
                <div className="stat">
                  <span className="muted">Filament</span>
                  <span style={{ color: other ? "var(--warn)" : undefined }}>{f?.label ?? summary.settings.filament}{other ? " — not what's loaded now: tap Try again" : ""}</span>
                </div>
              );
            })()}
            <div className="stat"><span className="muted">Printer file</span><span>{summary.gx.ok ? `${summary.gx.fileName} · ${summary.gx.verified ? "verified" : "unverified format"}` : summary.gx.reason ?? "not created"}</span></div>
            {summary.repairs.length > 0 && <div className="stat"><span className="muted">Repaired</span><span className="small">{summary.repairs.slice(0, 3).join(", ")}</span></div>}
            {headsUp.length > 0 && <div className="small" style={{ marginTop: 6, fontWeight: 700 }}>Heads-up</div>}
            {headsUp.slice(0, 4).map((w) => <div key={w} className="muted small warn-line">⚠ {w}</div>)}
          </>
        )}
        <div className="row" style={{ marginTop: "auto", justifyContent: "space-between" }}>
          <span className="muted small" style={{ maxWidth: 360 }}>{summary && blockers.length === 0 ? "You'll be asked to confirm before anything is sent." : summary ? "Fix the problems above to print." : ""}</span>
          <button className="btn primary" disabled={!summary?.ok || blockers.length > 0 || busy} onClick={() => void print()}>Print it! 🖨️</button>
        </div>
      </section>
    </div>
  );
}
