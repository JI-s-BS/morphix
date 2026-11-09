// "📷 Photo to 3D": take or pick photos → say what to make → Gemini recommends Meshy or
// Claude CAD and shows the cleaned photo → the user taps a choice → progress → My Things.
// Nothing is generated and no credits are spent before that tap; nothing prints by itself.
import { useEffect, useRef, useState } from "react";
import { authedBlob, post } from "./api";
import { blobToBase64, PHONE_PHOTO_LIMITS, preparePhoto, shrinkToBudget, type PreparedPhoto } from "./photoPrep";

type Route = "meshy" | "cad";
interface RouteOption { route: Route; title: string; tagline: string; recommended: boolean; available: boolean; unavailableReason?: string; credits: number }
export interface PhotoPlanView {
  id: string;
  description: string;
  object: { name: string; description: string; category: "functional" | "decorative" };
  sizeMm: { width: number; depth: number; height: number };
  sizeConfidence: number;
  recommended: Route;
  reason: string;
  options: RouteOption[];
  photoCount: number;
  cleanup: { needed: boolean; reason: string; ready: boolean; cleaned: boolean; note: string; previews: number };
  hints: string[];
  started: { route: Route; jobId: string } | null;
}
interface Started { jobId: string; route: Route; credits: number }

const EXAMPLES = ["A keychain of my friend", "A 1:1 Sprite can that holds a pen", "A replacement for this broken clip", "A small figurine of this toy"];
const SAVED = "morphix.remote.photo3d";
const load = (): { plan: PhotoPlanView | null; started: Started | null } => {
  try { const v = JSON.parse(sessionStorage.getItem(SAVED) || "null"); if (v && typeof v === "object") return { plan: v.plan ?? null, started: v.started ?? null }; } catch { /* private mode */ }
  return { plan: null, started: null };
};
const save = (v: { plan: PhotoPlanView | null; started: Started | null }) => { try { sessionStorage.setItem(SAVED, JSON.stringify(v)); } catch { /* ignore */ } };

export function PhotoTo3D({ jobs, onOpenLibrary, refresh }: { jobs: any[]; onOpenLibrary: () => void; refresh: () => void }) {
  const restored = useRef(load()).current;
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [description, setDescription] = useState(restored.plan?.description ?? "");
  const [plan, setPlan] = useState<PhotoPlanView | null>(restored.plan);
  const [started, setStarted] = useState<Started | null>(restored.started);
  const [choice, setChoice] = useState<Route | null>(null);
  const [useOriginal, setUseOriginal] = useState(false);
  const [busy, setBusy] = useState<"" | "preparing" | "analyzing" | "cleaning" | "creating">("");
  const [error, setError] = useState("");
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  useEffect(() => save({ plan, started }), [plan, started]);
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!plan) return;
    const firstOk = plan.options.find((o) => o.route === plan.recommended && o.available) ?? plan.options.find((o) => o.available);
    setChoice((c) => c ?? firstOk?.route ?? null);
  }, [plan]);

  async function addFiles(list: FileList | null) {
    const files = Array.from(list || []);
    if (!files.length) return;
    setError("");
    const room = PHONE_PHOTO_LIMITS.maxPhotos - photos.length;
    if (room <= 0) { setError(`Up to ${PHONE_PHOTO_LIMITS.maxPhotos} photos.`); return; }
    setBusy("preparing");
    try {
      const prepared = await Promise.all(files.slice(0, room).map(preparePhoto));
      setPhotos((p) => [...p, ...prepared]);
      if (files.length > room) setError(`Only the first ${room} photo${room === 1 ? "" : "s"} were added (max ${PHONE_PHOTO_LIMITS.maxPhotos}).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      if (camera.current) camera.current.value = "";
      if (gallery.current) gallery.current.value = "";
    }
  }

  function removePhoto(id: string) {
    setPhotos((list) => list.filter((p) => { if (p.id === id) URL.revokeObjectURL(p.url); return p.id !== id; }));
  }

  async function analyze() {
    setError("");
    setBusy("analyzing");
    try {
      const fitted = await shrinkToBudget(photos);
      setPhotos(fitted);
      const images = await Promise.all(fitted.map(async (p) => ({ name: p.name, data: await blobToBase64(p.blob) })));
      const r = await post<{ plan: PhotoPlanView }>("/api/photo/analyze", { description: description.trim(), images });
      setChoice(null);
      setUseOriginal(false);
      setPlan(r.plan);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function pick(route: Route) {
    if (!plan) return;
    const option = plan.options.find((o) => o.route === route);
    if (!option?.available) return;
    setChoice(route);
    setError("");
    if (route === "meshy" && !plan.cleanup.ready) {
      setBusy("cleaning");
      try {
        const r = await post<{ plan: PhotoPlanView }>(`/api/photo/plans/${plan.id}/clean`, {});
        setPlan(r.plan);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy("");
      }
    }
  }

  async function create() {
    if (!plan || !choice) return;
    setError("");
    setBusy("creating");
    try {
      const r = await post<Started>("/api/photo/create", { planId: plan.id, route: choice, useOriginal: choice === "meshy" && useOriginal });
      setStarted(r);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  function reset() {
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
    setPlan(null);
    setStarted(null);
    setChoice(null);
    setUseOriginal(false);
    setDescription("");
    setError("");
  }

  // ------------------------------------------------------------ started: progress
  if (started) {
    const job = jobs.find((j) => j.id === started.jobId);
    const stage = job?.stages?.find((s: any) => s.key === job.currentStage);
    const done = job?.status === "done";
    const failed = job?.status === "failed" || job?.status === "cancelled";
    return (
      <section className="photo3d">
        <div className="page-head">
          <span className="eyebrow">📷 Photo to 3D</span>
          <h1>{done ? "It's ready" : failed ? "That didn't work" : "Making it…"}</h1>
          <p>{plan?.object.name ?? "Your model"} · {started.route === "cad" ? "Claude CAD" : `Meshy${started.credits ? ` · ${started.credits} credits` : ""}`}</p>
        </div>
        <div className="p3-card">
          <div className="progress"><i style={{ width: `${Math.round(job?.percent ?? 2)}%` }} /></div>
          <p className="p3-status">{Math.round(job?.percent ?? 0)}% · {stage?.detail || stage?.label || (job ? "Working…" : "Starting on the Pi…")}</p>
          <ol className="p3-stages">
            {(job?.stages ?? []).filter((s: any) => s.status !== "skipped").map((s: any) => (
              <li key={s.key} className={s.status}>{s.status === "done" ? "✓" : s.status === "running" ? "◌" : s.status === "failed" ? "✕" : "·"} {s.label}</li>
            ))}
          </ol>
          {failed && job?.error && <div className="error">{job.error.code}: {job.error.title}{job.error.hint ? ` — ${job.error.hint}` : ""}</div>}
          {done && <p className="p3-ok">It's in My Things on the Pi and prepared for printing. Nothing prints until you approve it.</p>}
        </div>
        <div className="p3-row">
          {done && <button className="primary" onClick={onOpenLibrary}>Open My Things</button>}
          <button className="secondary" onClick={reset}>Make something else</button>
        </div>
      </section>
    );
  }

  // ------------------------------------------------------------ plan: choose a route
  if (plan) {
    const chosen = plan.options.find((o) => o.route === choice);
    return (
      <section className="photo3d">
        <div className="page-head">
          <span className="eyebrow">📷 Photo to 3D</span>
          <h1>{plan.object.name}</h1>
          <p>About {plan.sizeMm.width} × {plan.sizeMm.depth} × {plan.sizeMm.height} mm{plan.sizeConfidence < 0.5 ? " (a guess — you can resize later)" : ""}.</p>
        </div>
        <div className="ai-note">
          <span>✦</span>
          <p><b>Gemini recommends {plan.recommended === "cad" ? "Claude CAD" : "Meshy"}</b><br />{plan.reason}</p>
        </div>

        {choice === "meshy" && (
          <div className="p3-card">
            <b>What Meshy will get</b>
            {busy === "cleaning" ? (
              <p className="p3-status">Cleaning up the photo (removing the background)…</p>
            ) : plan.cleanup.previews ? (
              <>
                <div className="p3-previews">
                  {Array.from({ length: plan.cleanup.previews }, (_, i) => (
                    <PlanPreview key={`${plan.id}-${i}-${plan.cleanup.cleaned}`} path={`/api/photo/plans/${plan.id}/preview/${i}`} dim={useOriginal && plan.cleanup.cleaned} />
                  ))}
                </div>
                <p className="p3-status">{plan.cleanup.note}</p>
                {plan.cleanup.cleaned && (
                  <label className="p3-check">
                    <input type="checkbox" checked={useOriginal} onChange={(e) => setUseOriginal(e.target.checked)} /> Send my original photo instead
                  </label>
                )}
              </>
            ) : (
              <p className="p3-status">The photo will be prepared when you choose Meshy.</p>
            )}
          </div>
        )}

        <div className="p3-options" role="radiogroup" aria-label="How should Morphix make it?">
          {plan.options.map((o) => (
            <button key={o.route} role="radio" aria-checked={choice === o.route} disabled={!o.available || !!busy} className={`p3-option ${choice === o.route ? "active" : ""}`} onClick={() => void pick(o.route)}>
              <span className="p3-option-head">
                <b>{o.title}</b>
                {o.recommended && <em>Recommended</em>}
              </span>
              <span>{o.tagline}</span>
              <small>{o.available ? (o.credits ? `Uses ${o.credits} Meshy credits` : "No Meshy credits") : o.unavailableReason}</small>
            </button>
          ))}
        </div>
        {plan.hints.length > 0 && <p className="p3-hint">Worth checking: {plan.hints[0]}</p>}
        {error && <div className="error">{error}</div>}
        <button className="primary wide" disabled={!chosen?.available || !!busy} onClick={create}>
          {busy === "creating" ? "Starting…" : !chosen ? "Choose how to make it" : chosen.route === "meshy" ? `Create with Meshy · ${chosen.credits} credits` : "Create with Claude CAD"}
        </button>
        <button className="secondary wide" disabled={!!busy} onClick={() => { setPlan(null); setChoice(null); }}>Back</button>
      </section>
    );
  }

  // ------------------------------------------------------------ photos + description
  return (
    <section className="photo3d">
      <div className="page-head">
        <span className="eyebrow">📷 Photo to 3D</span>
        <h1>Photo to 3D</h1>
        <p>Take a picture of anything — a can, a friend, a toy, a broken part — and say what to make.</p>
      </div>
      <input ref={camera} hidden type="file" accept="image/*" capture="environment" onChange={(e) => void addFiles(e.target.files)} />
      <input ref={gallery} hidden type="file" accept="image/*" multiple onChange={(e) => void addFiles(e.target.files)} />
      {photos.length ? (
        <div className="p3-photos">
          {photos.map((p) => (
            <figure key={p.id}>
              <img src={p.url} alt="" />
              <button aria-label="Remove photo" onClick={() => removePhoto(p.id)}>×</button>
            </figure>
          ))}
          {photos.length < PHONE_PHOTO_LIMITS.maxPhotos && (
            <button className="p3-add" disabled={!!busy} onClick={() => gallery.current?.click()}>＋<small>Another angle</small></button>
          )}
        </div>
      ) : (
        <div className="p3-pick">
          <button className="primary" disabled={!!busy} onClick={() => camera.current?.click()}>📷 Take a photo</button>
          <button className="secondary" disabled={!!busy} onClick={() => gallery.current?.click()}>🖼 Choose from gallery</button>
          <p>Up to {PHONE_PHOTO_LIMITS.maxPhotos} photos of the same thing. Location data is removed on your phone.</p>
        </div>
      )}
      {photos.length > 0 && photos.length < PHONE_PHOTO_LIMITS.maxPhotos && (
        <button className="secondary p3-retake" disabled={!!busy} onClick={() => camera.current?.click()}>📷 Take another photo</button>
      )}
      <label className="prompt-label">
        What should we make from this?
        <textarea rows={3} maxLength={600} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="“A keychain of my friend”" />
      </label>
      <div className="p3-examples">
        {EXAMPLES.map((x) => <button key={x} onClick={() => setDescription(x)}>{x}</button>)}
      </div>
      {error && <div className="error">{error}</div>}
      <button className="primary wide" disabled={!!busy || !photos.length || !description.trim()} onClick={analyze}>
        {busy === "preparing" ? "Preparing photos…" : busy === "analyzing" ? "Gemini is looking at your photo…" : "See how to make it"}
      </button>
      <p className="p3-hint">Free: nothing is created and no credits are used until you choose.</p>
    </section>
  );
}

function PlanPreview({ path, dim }: { path: string; dim: boolean }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url = "", dead = false;
    authedBlob(path).then((b) => { if (dead) return; url = URL.createObjectURL(b); setSrc(url); }).catch(() => !dead && setFailed(true));
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return <div className={`p3-preview ${dim ? "dim" : ""}`}>{src ? <img src={src} alt="Photo Meshy will receive" /> : <span>{failed ? "Preview unavailable" : "Loading…"}</span>}</div>;
}
