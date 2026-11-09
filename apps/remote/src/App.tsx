import { useEffect, useMemo, useRef, useState } from "react";
import { API, forgetToken, post, request, saveToken, token } from "./api";
import { auth0Config, auth0IdToken, auth0LoginUrl, readAuth0Callback } from "./auth0";
import { ModelViewer } from "./ModelViewer";
import { PhotoTo3D } from "./PhotoTo3D";

type State = any;
const fmtTime = (s: number | null | undefined) =>
  !s
    ? "—"
    : s < 3600
      ? `${Math.ceil(s / 60)} min`
      : `${Math.floor(s / 3600)}h ${Math.ceil((s % 3600) / 60)}m`;

const phoneName = () =>
  navigator.userAgent.includes("iPhone")
    ? "iPhone"
    : navigator.userAgent.includes("Android")
      ? "Android phone"
      : "My phone";

function Pair({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; qr: boolean } | null>(null);
  const code = useMemo(
    () => new URLSearchParams(location.hash.slice(1)).get("pair") || "",
    [],
  );
  const auth0 = useMemo(auth0Config, []);
  const callback = useMemo(() => (auth0 && !code ? readAuth0Callback() : null), []);
  const started = useRef(false);
  const finish = (r: { token: string }) => {
    saveToken(r.token);
    history.replaceState(null, "", location.pathname);
    onDone();
  };
  useEffect(() => {
    if (!code || started.current) return;
    started.current = true;
    setBusy(true);
    post<any>("/api/pair", { code, name: phoneName() })
      .then(finish)
      .catch((e) => setError({ text: (e as Error).message, qr: true }))
      .finally(() => setBusy(false));
  }, [code]);
  // Back from Auth0's Universal Login: swap the code for an ID token, the Pi turns it into a device key.
  useEffect(() => {
    if (!auth0 || !callback || started.current) return;
    started.current = true;
    if ("error" in callback) {
      setError({ text: callback.error, qr: false });
      return;
    }
    setBusy(true);
    auth0IdToken(auth0, callback)
      .then((idToken) => post<any>("/api/pair/auth0", { idToken, name: phoneName() }))
      .then(finish)
      .catch((e) => setError({ text: (e as Error).message, qr: false }))
      .finally(() => setBusy(false));
  }, []);
  async function signIn() {
    if (!auth0) return;
    setBusy(true);
    setError(null);
    try {
      const { nonce } = await post<{ nonce: string }>("/api/pair/auth0/start", {});
      location.assign(await auth0LoginUrl(auth0, nonce));
    } catch (e) {
      const m = (e as Error).message;
      setError({
        text: /MX-AUTH|too many/i.test(m)
          ? m
          : "Morphix isn't online. Check that Morphix is switched on, then try again.",
        qr: false,
      });
      setBusy(false);
    }
  }
  return (
    <main className="pair">
      <div className="brand">
        <span className="brandmark">M</span>
        <span>
          Morphix <b>Remote</b>
        </span>
      </div>
      <div className="pair-art">
        <div className="printer-cube">
          <i />
          <i />
          <i />
        </div>
        <span className="signal s1" />
        <span className="signal s2" />
        <span className="signal s3" />
      </div>
      <section className="pair-card">
        <span className="eyebrow">Private connection</span>
        <h1>{busy ? (code ? "Pairing securely…" : "Signing in…") : "Connect your phone"}</h1>
        <p>
          {code
            ? "Morphix is verifying this phone and creating its private device key."
            : "On the Raspberry Pi screen, open Morphix Settings → Remote Access. Then use your phone’s regular Camera app to scan the QR shown on the Pi—not this page."}
        </p>
        <div className="scan-icon">
          ⌁<span>▦</span>
        </div>
        {error && (
          <div className="error">
            {error.qr
              ? `${error.text}. Open Settings on the Pi and scan the refreshed QR.`
              : error.text}
          </div>
        )}
        {auth0 && !code && (
          <>
            <div className="pair-or">
              <span>or</span>
            </div>
            <button className="auth0-btn" disabled={busy} onClick={() => void signIn()}>
              <span aria-hidden="true">🔒</span>
              {busy ? "Signing in…" : "Sign in with Auth0"}
            </button>
          </>
        )}
        <small>
          {auth0
            ? "Scan the QR on the Pi, or sign in with an approved account"
            : "The QR appears on the Pi · No account or password"}
        </small>
      </section>
    </main>
  );
}

function Camera() {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let dead = false, url = "", loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (dead || loading) return;
      loading = true;
      try {
        const r = await fetch(`${API}/api/camera/snapshot?t=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token()}` },
          signal: controller.signal,
          cache: "no-store",
        });
        if (!r.ok) throw new Error("Camera preview unavailable");
        const next = URL.createObjectURL(await r.blob());
        if (dead) { URL.revokeObjectURL(next); return; }
        if (url) URL.revokeObjectURL(url);
        url = next;
        setSrc(next);
        setError("");
      } catch (e) {
        if (!dead && !src) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void load();
    const interval = setInterval(() => void load(), 1_500);
    return () => {
      dead = true;
      clearInterval(interval);
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, []);
  return (
    <div className="camera">
      {src ? (
        <img src={src} alt="Live printer camera" />
      ) : (
        <div className="camera-empty">
          <span>◉</span>
          {error || "Connecting to camera…"}
        </div>
      )}
      <span className="live">
        <i /> LIVE
      </span>
    </div>
  );
}

function Chat({ state, refresh }: { state: State; refresh: () => void }) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false);
  const audio = useRef<{
    ctx: AudioContext;
    node: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    stream: MediaStream;
    chunks: Int16Array[];
  } | null>(null);
  const turns = state?.conversation || [];
  async function downloadModel(resultId: string) {
    setBusy(true);
    try {
      const out = await post<any>("/api/models/download", { resultId });
      alert(`Got all ${out.parts.length} part${out.parts.length === 1 ? "" : "s"} — it's in My Things on the Pi, ready to prepare.${out.warnings.length ? ` ${out.warnings.join(" ")}` : ""}`);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importParts(resultId:string, selected:FileList|null){
    const chosen=Array.from(selected||[]); if(!chosen.length)return;
    setBusy(true);
    try{
      const files=[] as {name:string;data:string}[];
      for(const file of chosen){const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.slice(i,i+8192));files.push({name:file.name,data:btoa(binary)})}
      const out=await post<any>("/api/models/import",{resultId,files}); alert(`Imported ${out.parts.length} printable part${out.parts.length===1?"":"s"} to the Pi.${out.warnings.length?` ${out.warnings.join(" ")}`:""}`); await refresh();
    }catch(e){alert((e as Error).message)}finally{setBusy(false)}
  }
  // Gemini asked "Meshy, Claude or open source?": open the chat so the buttons are seen.
  const choiceAt = state?.engineChoice?.at;
  useEffect(() => {
    if (choiceAt) setOpen(true);
  }, [choiceAt]);
  async function send(said?: string) {
    const v = (said ?? text).trim();
    if (!v) return;
    setBusy(true);
    if (said === undefined) setText("");
    try {
      await post("/api/assistant/text", { text: v });
      setTimeout(refresh, 1200);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleVoice() {
    if (recording) {
      const a = audio.current;
      if (!a) return;
      a.node.disconnect();
      a.source.disconnect();
      a.stream.getTracks().forEach((t) => t.stop());
      await a.ctx.close();
      const len = a.chunks.reduce((n, c) => n + c.length, 0),
        pcm = new Int16Array(len);
      let p = 0;
      a.chunks.forEach((c) => {
        pcm.set(c, p);
        p += c.length;
      });
      let binary = "";
      const bytes = new Uint8Array(pcm.buffer);
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.slice(i, i + 8192));
      setRecording(false);
      setBusy(true);
      try {
        await post("/api/assistant/voice", {
          pcm: btoa(binary),
          sampleRate: 16000,
        });
        setTimeout(refresh, 1200);
      } catch (e) {
        alert((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext({ sampleRate: 16000 }),
      source = ctx.createMediaStreamSource(stream),
      node = ctx.createScriptProcessor(4096, 1, 1),
      chunks: Int16Array[] = [];
    node.onaudioprocess = (e) => {
      const f = e.inputBuffer.getChannelData(0),
        out = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++)
        out[i] = Math.max(-32768, Math.min(32767, f[i] * 32768));
      chunks.push(out);
    };
    source.connect(node);
    node.connect(ctx.destination);
    audio.current = { ctx, node, source, stream, chunks };
    setRecording(true);
  }
  return (
    <>
      <button className="chat-fab" onClick={() => setOpen(true)}>
        ✦<span>Ask Gemini</span>
      </button>
      {open && (
        <div className="sheet-back" onClick={() => setOpen(false)}>
          <section className="chat-sheet" onClick={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span className="gemini-dot">✦</span>
                <b>Gemini for Morphix</b>
                <small>Connected to your Pi</small>
              </div>
              <button onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="turns">
              {turns.length ? (
                turns.map((t: any) => (
                  <div key={t.id} className={`turn ${t.role}`}>
                    {t.text}
                  </div>
                ))
              ) : (
                <div className="chat-welcome">
                  <span>✦</span>
                  <h3>What should we make?</h3>
                  <p>
                    Describe it, ask about a photo, or request changes to your
                    current model.
                  </p>
                </div>
              )}
              {state?.engineChoice && <EngineButtons choice={state.engineChoice} busy={busy} onPick={(say) => void send(say)} />}
              {state?.smartSearch && <SearchResults search={state.smartSearch} busy={busy} onImport={importParts} onDownload={downloadModel} refresh={refresh} />}
            </div>
            <div className="composer">
              <button
                className={recording ? "recording" : ""}
                onClick={toggleVoice}
              >
                {recording ? "■" : "●"}
              </button>
              <textarea
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={recording ? "Listening…" : "Message Gemini…"}
              />
              <button disabled={busy || !text.trim()} onClick={() => void send()}>
                ↑
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function App() {
  const [paired, setPaired] = useState(Boolean(token())),
    [state, setState] = useState<State>(null),
    [tab, setTab] = useState("home"),
    [selected, setSelected] = useState<string | null>(null),
    [project, setProject] = useState<any>(null),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const notify = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(""), 3200);
  };
  async function refresh() {
    if (!token()) return;
    try {
      const s = await request<State>("/api/state");
      setState(s);
      setPaired(true);
      setError("");
    } catch (e) {
      const m = (e as Error).message;
      setError(m);
      if (!token()) setPaired(false);
    }
  }
  useEffect(() => {
    void refresh();
    const n = setInterval(refresh, 3000);
    return () => clearInterval(n);
  }, [paired]);
  useEffect(() => {
    if (!selected) return;
    request<any>(`/api/projects/${selected}`)
      .then((r) => setProject(r.project))
      .catch(() => setProject(null));
  }, [selected, state?.projects?.map((p: any) => p.updatedAt).join()]);
  if (!paired)
    return (
      <Pair
        onDone={() => {
          setPaired(true);
          void refresh();
        }}
      />
    );
  const pending = state?.actions?.[0],
    printer = state?.printer,
    print = state?.print,
    guardian = state?.guardian,
    projects = state?.projects || [];
  const current = project || projects[0];
  const version = current?.versions?.[0];
  async function act(path: string, body: any, msg: string) {
    try {
      await post(path, body);
      notify(msg);
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brandmark">M</span>
          <span>
            Morphix <b>Remote</b>
          </span>
        </div>
        <div className={`pi ${printer?.online ? "online" : ""}`}>
          <i />
          {printer?.online ? "Pi online" : "Pi offline"}
        </div>
      </header>
      {error && <div className="offline">{error}</div>}
      <main className="content">
        {tab === "home" && (
          <>
            <section className="hero">
              <div>
                <span className="eyebrow">Ready to create</span>
                <h1>
                  Turn an idea into
                  <br />
                  <em>something real.</em>
                </h1>
                <p>
                  Talk to Gemini or start with a photo. Morphix handles the rest
                  on your Pi.
                </p>
                <div className="hero-actions">
                  <button className="primary" onClick={() => setTab("create")}>
                    📷 Photo to 3D
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      document
                        .querySelector<HTMLButtonElement>(".chat-fab")
                        ?.click()
                    }
                  >
                    ✦ Talk to Gemini
                  </button>
                </div>
              </div>
              <div className="orb">
                <div className="wirecube">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </section>
            <section className="status-grid">
              <article>
                <span className="icon cyan">◈</span>
                <div>
                  <small>Printer</small>
                  <b>
                    {printer?.online ? printer.state || "Ready" : "Offline"}
                  </b>
                  <p>{printer?.currentFile || "QD330 connected through Pi"}</p>
                </div>
                <span className={`dot ${printer?.online ? "good" : ""}`} />
              </article>
              <article>
                <span className="icon violet">✦</span>
                <div>
                  <small>AI Print Guardian</small>
                  <b>
                    {guardian?.running
                      ? guardian.label || "Watching"
                      : "Standing by"}
                  </b>
                  <p>
                    {guardian?.alert
                      ? "Attention needed"
                      : guardian?.running
                        ? "Monitoring your print"
                        : "Starts automatically when printing"}
                  </p>
                </div>
                <span
                  className={`dot ${guardian?.alert ? "bad" : guardian?.running ? "good" : ""}`}
                />
              </article>
            </section>
            <section className="home-camera">
              <div className="section-title">
                <div>
                  <span className="eyebrow">Live from your Pi</span>
                  <h2>Printer camera</h2>
                </div>
                <button onClick={() => setTab("print")}>Open controls</button>
              </div>
              <Camera />
            </section>
            {state?.jobs
              ?.filter(
                (j: any) => !["done", "failed", "cancelled"].includes(j.status),
              )
              .slice(0, 1)
              .map((j: any) => (
                <section className="active-print" key={j.id}>
                  <div className="print-thumb">✦</div>
                  <div>
                    <span className="eyebrow">Morphix is working</span>
                    <h3>{j.title}</h3>
                    <div className="progress">
                      <i style={{ width: `${j.percent || 0}%` }} />
                    </div>
                    <p>
                      {Math.round(j.percent || 0)}% ·{" "}
                      {j.stages?.find((s: any) => s.key === j.currentStage)
                        ?.detail ||
                        j.stages?.find((s: any) => s.key === j.currentStage)
                          ?.label ||
                        "Starting…"}
                    </p>
                  </div>
                </section>
              ))}
            {print?.job && (
              <section className="active-print" onClick={() => setTab("print")}>
                <div className="print-thumb">▰</div>
                <div>
                  <span className="eyebrow">Printing now</span>
                  <h3>{print.job.fileName || "Morphix model"}</h3>
                  <div className="progress">
                    <i style={{ width: `${print.job.progress || 0}%` }} />
                  </div>
                  <p>
                    {Math.round(print.job.progress || 0)}% · Layer{" "}
                    {print.job.layer?.[0] || 0} of {print.job.layer?.[1] || "—"}
                  </p>
                </div>
                <b>›</b>
              </section>
            )}
            <div className="section-title">
              <h2>Recent creations</h2>
              <button onClick={() => setTab("library")}>View all</button>
            </div>
            <div className="project-strip">
              {projects.length ? (
                projects.slice(0, 5).map((p: any) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelected(p.id);
                      setTab("model");
                    }}
                  >
                    <div className="thumb">
                      {p.hasThumbnail ? (
                        <AuthImage
                          path={`/api/thumbnails/${p.latestVersionId}`}
                          alt=""
                        />
                      ) : (
                        <span>◇</span>
                      )}
                    </div>
                    <b>{p.title}</b>
                    <small>{p.state}</small>
                  </button>
                ))
              ) : (
                <div className="empty-projects">
                  Your models will appear here.
                </div>
              )}
            </div>
          </>
        )}
        {tab === "create" && (
          <Create
            jobs={state?.jobs || []}
            refresh={refresh}
            onOpenLibrary={() => setTab("library")}
            onStarted={() => {
              notify("Sent — Gemini will ask how to make it");
              setTab("home");
              void refresh();
            }}
          />
        )}
        {tab === "library" && (
          <>
            <div className="page-head">
              <span className="eyebrow">Stored on your Pi</span>
              <h1>Your creations</h1>
            </div>
            <div className="library-grid">
              {projects.map((p: any) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelected(p.id);
                    setTab("model");
                  }}
                >
                  <div className="thumb">
                    {p.hasThumbnail ? (
                      <AuthImage
                        path={`/api/thumbnails/${p.latestVersionId}`}
                        alt=""
                      />
                    ) : (
                      <span>◇</span>
                    )}
                  </div>
                  <div>
                    <b>{p.title}</b>
                    <small>
                      {p.state} · {new Date(p.updatedAt).toLocaleDateString()}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        {tab === "model" && current && (
          <Model
            project={current}
            version={version}
            pending={pending}
            act={act}
            refresh={refresh}
          />
        )}
        {tab === "print" && (
          <PrintView
            printer={printer}
            print={print}
            guardian={guardian}
            act={act}
          />
        )}
      </main>
      {pending && (
        <div className="approval">
          <div>
            <span className="eyebrow">Approval required</span>
            <b>
              {pending.kind === "print"
                ? "Ready to send to QD330"
                : `Create “${pending.title}”?`}
            </b>
            <p>{pending.details?.join(" · ")}</p>
          </div>
          <button
            className="secondary"
            onClick={() =>
              act("/api/actions/cancel", { id: pending.id }, "Cancelled")
            }
          >
            Not now
          </button>
          <button
            className="primary"
            onClick={() =>
              act(
                "/api/actions/confirm",
                { id: pending.id },
                pending.kind === "print"
                  ? "Print approved"
                  : "Generation started",
              )
            }
          >
            {pending.kind === "print" ? "Approve print" : "Approve"}
          </button>
        </div>
      )}
      <Chat state={state} refresh={refresh} />
      <nav>
        <button
          className={tab === "home" ? "active" : ""}
          onClick={() => setTab("home")}
        >
          <span>⌂</span>Home
        </button>
        <button
          className={tab === "create" ? "active" : ""}
          onClick={() => setTab("create")}
        >
          <span>＋</span>Create
        </button>
        <button
          className={tab === "library" || tab === "model" ? "active" : ""}
          onClick={() => setTab("library")}
        >
          <span>◇</span>Models
        </button>
        <button
          className={tab === "print" ? "active" : ""}
          onClick={() => setTab("print")}
        >
          <span>▰</span>Print
        </button>
        <button
          onClick={() => {
            if (confirm("Unpair this device from Morphix Remote? You will need to scan the Pi's QR again.")) {
              forgetToken();
              setPaired(false);
            }
          }}
        >
          <span>⇥</span>Unpair
        </button>
      </nav>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function AuthImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let url = "";
    fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => r.blob())
      .then((b) => {
        url = URL.createObjectURL(b);
        setSrc(url);
      });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return src ? <img src={src} alt={alt} /> : null;
}

function Create({ onStarted, jobs, refresh, onOpenLibrary }: { onStarted: () => void; jobs: any[]; refresh: () => void; onOpenLibrary: () => void }) {
  const [mode, setMode] = useState<"photo" | "idea">("photo"),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false);
  const tabs = (
    <div className="segmented">
      <button className={mode === "photo" ? "active" : ""} onClick={() => setMode("photo")}>
        📷 Photo to 3D
      </button>
      <button className={mode === "idea" ? "active" : ""} onClick={() => setMode("idea")}>
        ✦ Describe an idea
      </button>
    </div>
  );
  if (mode === "photo")
    return (
      <section className="create">
        {tabs}
        <PhotoTo3D jobs={jobs} refresh={refresh} onOpenLibrary={onOpenLibrary} />
      </section>
    );
  async function go() {
    setBusy(true);
    try {
      await post("/api/assistant/text", { text: `Make me: ${description}` });
      onStarted();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="create">
      {tabs}
      <div className="page-head">
        <span className="eyebrow">New creation</span>
        <h1>What should we make?</h1>
        <p>Gemini asks whether to use Meshy, Claude or an open-source design, and recommends one.</p>
      </div>
      <label className="prompt-label">
        Describe your model
        <textarea
          rows={5}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="“A friendly robot planter with round feet…”"
        />
      </label>
      <div className="ai-note">
        <span>✦</span>
        <p>
          <b>Gemini will ask how to make it</b>
          <br />
          Meshy for toys and figures, Claude for exact-size parts, or a proven
          open-source design. Meshy credits are only used after you approve.
        </p>
      </div>
      <button
        className="primary wide"
        disabled={busy || !description.trim()}
        onClick={go}
      >
        {busy ? "Sending securely…" : "Ask Gemini"}
      </button>
    </section>
  );
}

function Model({
  project,
  version,
  pending,
  act,
  refresh,
}: {
  project: any;
  version: any;
  pending: any;
  act: any;
  refresh: any;
}) {
  const [height, setHeight] = useState(version?.targetHeightMm || 80);
  const summary = project?.id ? null : null;
  return (
    <section className="model-page">
      <div className="page-head">
        <span className="eyebrow">Model studio</span>
        <h1>{project.title}</h1>
        <p>{project.prompt}</p>
      </div>
      {version ? (
        <>
          <ModelViewer versionId={version.id} format={version.format} />
          <div className="model-meta">
            <span>Version {version.version}</span>
            <span>{version.format.toUpperCase()}</span>
            <span>{(version.bytes / 1e6).toFixed(1)} MB</span>
          </div>
          <div className="control-card">
            <div>
              <h3>How big should it be?</h3>
              <p>
                Set the finished height. Morphix keeps proportions and checks
                the QD330 build area.
              </p>
            </div>
            <div className="size-row">
              <input
                type="range"
                min="10"
                max="220"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
              />
              <label>
                <input
                  type="number"
                  min="10"
                  max="220"
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                />
                <span>mm</span>
              </label>
            </div>
            <button
              className="secondary wide"
              onClick={() =>
                act(
                  `/api/versions/${version.id}/height`,
                  { heightMm: height },
                  "Size saved",
                )
              }
            >
              Save size
            </button>
          </div>
          <div className="model-actions">
            <button
              className="secondary"
              onClick={() =>
                document.querySelector<HTMLButtonElement>(".chat-fab")?.click()
              }
            >
              ✦ Ask Gemini for changes
            </button>
            <button
              className="secondary"
              disabled={Boolean(pending)}
              onClick={() =>
                act(
                  `/api/versions/${version.id}/refine`,
                  {},
                  "Refinement ready for approval",
                )
              }
            >
              ◇ Refine model
            </button>
            <button
              className="primary"
              onClick={async () => {
                await act(
                  `/api/versions/${version.id}/prepare`,
                  { settings: "auto" },
                  "Slicing complete",
                );
                refresh();
              }}
            >
              Prepare & slice
            </button>
          </div>
          <Prepared projectId={project.id} act={act} />
        </>
      ) : (
        <div className="empty">
          This model is still generating. Progress updates appear on Home.
        </div>
      )}
    </section>
  );
}

function Prepared({ projectId, act }: { projectId: string; act: any }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    request<any>(`/api/projects/${projectId}/latest-print`).then((r) =>
      setS(r.summary),
    );
  }, [projectId]);
  if (!s) return null;
  return (
    <div className={`prepared ${s.ok ? "ok" : ""}`}>
      <span>{s.ok ? "✓" : "!"}</span>
      <div>
        <h3>
          {s.ok ? "Ready for your approval" : "Preparation needs attention"}
        </h3>
        {s.ok ? (
          <p>
            {s.size &&
              `${s.size.x.toFixed(0)} × ${s.size.y.toFixed(0)} × ${s.size.z.toFixed(0)} mm`}{" "}
            · {fmtTime(s.estimates?.printTimeS)} ·{" "}
            {s.estimates?.filamentG?.toFixed(1) || "—"} g filament
          </p>
        ) : (
          <p>{s.error || s.slicer?.message}</p>
        )}
      </div>
      {s.ok && (
        <button
          className="primary"
          onClick={() =>
            act(
              "/api/print/request",
              { jobId: s.jobId },
              "Print approval requested",
            )
          }
        >
          Review print
        </button>
      )}
    </div>
  );
}

function PrintView({
  printer,
  print,
  guardian,
  act,
}: {
  printer: any;
  print: any;
  guardian: any;
  act: any;
}) {
  const active = print?.job;
  return (
    <section className="print-page">
      <div className="page-head">
        <span className="eyebrow">QD330 control</span>
        <h1>{active ? "Print in progress" : "Printer ready"}</h1>
        <p>
          {printer?.online
            ? "Securely connected through your Raspberry Pi."
            : "The printer is currently offline."}
        </p>
      </div>
      <Camera />
      {active && (
        <div className="print-progress">
          <div>
            <b>{Math.round(active.progress || 0)}%</b>
            <span>{active.phase}</span>
          </div>
          <div className="progress">
            <i style={{ width: `${active.progress || 0}%` }} />
          </div>
          <p>
            Layer {active.layer?.[0] || 0} of {active.layer?.[1] || "—"}
          </p>
        </div>
      )}
      <div className={`guardian-card ${guardian?.alert ? "alert" : ""}`}>
        <span>✦</span>
        <div>
          <small>AI Print Guardian</small>
          <b>
            {guardian?.alert
              ? "Possible failure detected"
              : guardian?.running
                ? guardian.label
                : "Standing by"}
          </b>
          <p>
            {guardian?.alert?.explanation ||
              "Camera analysis stays on your Pi and starts with every print."}
          </p>
        </div>
      </div>
      {guardian?.voice?.awaitingAnswer && (
        <div className="danger-choice">
          <b>Should Morphix stop this print?</b>
          <button
            className="danger"
            onClick={() =>
              act(
                "/api/guardian/answer",
                { decision: "stop" },
                "Stopping requested",
              )
            }
          >
            Yes, stop
          </button>
          <button
            className="secondary"
            onClick={() =>
              act(
                "/api/guardian/answer",
                { decision: "keep" },
                "Continuing print",
              )
            }
          >
            Keep printing
          </button>
        </div>
      )}
      <div className="print-controls">
        <button
          disabled={!active || active.phase === "paused"}
          onClick={() =>
            act("/api/print/control", { command: "pause" }, "Pause requested")
          }
        >
          Ⅱ Pause
        </button>
        <button
          disabled={!active || active.phase !== "paused"}
          onClick={() =>
            act("/api/print/control", { command: "resume" }, "Resume requested")
          }
        >
          ▶ Resume
        </button>
        <button
          className="danger"
          disabled={!active}
          onClick={() =>
            confirm("Stop and cancel this print?") &&
            act("/api/print/control", { command: "cancel" }, "Cancel requested")
          }
        >
          ■ Stop
        </button>
      </div>
      <p className="safety">
        Controls only report success after the QD330 confirms the command.
        Starting a print always requires a separate approval.
      </p>
    </section>
  );
}

const ENGINES = [
  { id: "meshy", icon: "🐉", name: "Meshy", what: "Toys, figures, things to hold or look at", say: "Use Meshy" },
  { id: "claude", icon: "📐", name: "Claude", what: "Exact-size parts that fit or work", say: "Use Claude" },
  { id: "open_source", icon: "🌍", name: "Open source", what: "A proven free design", say: "Find an open-source design" },
];

/** Gemini's "Meshy, Claude or open source?" question; tapping answers Gemini in words. */
function EngineButtons({ choice, busy, onPick }: { choice: any; busy: boolean; onPick: (say: string) => void }) {
  return (
    <div className="engine-choice">
      <div className="search-status">How should Morphix make “{choice.request}”?</div>
      <div className="engine-options">
        {ENGINES.map((o) => {
          const off = o.id === "claude" && !choice.claudeAvailable;
          return (
            <button key={o.id} className={o.id === choice.recommended ? "engine-option recommended" : "engine-option"} disabled={busy || off} onClick={() => onPick(o.say)}>
              <span>{o.icon}</span>
              <b>{o.name}{o.id === choice.recommended ? " ⭐" : ""}</b>
              <small>{off ? "Needs its key first" : o.what}</small>
            </button>
          );
        })}
      </div>
      {choice.reason && <p className="engine-reason">⭐ Recommended: {choice.reason}</p>}
    </div>
  );
}

const SITE: Record<string, string> = { printables: "Printables", thingiverse: "Thingiverse", makerworld: "MakerWorld", github: "GitHub", other: "Model library" };

/** Smart Model Search results: real pages checked by the Pi. Never starts Meshy or a print. */
function SearchResults({ search, busy, onImport, onDownload, refresh }: {
  search: any; busy: boolean;
  onImport: (resultId: string, files: FileList | null) => Promise<void>;
  onDownload: (resultId: string) => Promise<void>;
  refresh: () => void | Promise<void>;
}) {
  if (search.status === "searching") return <div className="search-status">🔎 Looking for real designs for “{search.query}”…</div>;
  if (search.status === "failed") return <div className="error">{search.error}</div>;
  return (
    <div className="search-results">
      <div className="search-status">Real designs for “{search.query}” — tap the one you want.</div>
      {search.results.map((r: any, i: number) => {
        const chosen = search.selectedId === r.id;
        return (
          <article className={`search-card${chosen ? " chosen" : ""}`} key={r.id}>
            {r.imageUrl && <img src={r.imageUrl} alt="" />}
            <div>
              <small>{i + 1}. {SITE[r.source] ?? r.source}{r.creator ? ` · by ${r.creator}` : ""}</small>
              <b>{r.name}</b>
              <p>{r.license ? `${r.license}${r.licenseVerified ? " ✓ (on the page)" : " (as listed — check the page)"}` : "Licence: check the page"}</p>
              <p>{r.description}</p>
              <p><strong>{r.printAsIs ? "✅ Prints as-is" : "🔧 Needs assembly"}</strong>{r.parts?.length ? ` · ${r.parts.length} printed part${r.parts.length === 1 ? "" : "s"}: ${r.parts.join(", ")}` : ""}</p>
              {r.nonPrintedParts?.length > 0 && <p><strong>Also needs:</strong> {r.nonPrintedParts.join(", ")}</p>}
              {r.assembly?.length > 0 && <p><strong>Assembly:</strong> {r.assembly.join(" ")}</p>}
              <p>{r.evidence?.length ? `Printed by others: ${r.evidence.join("; ")}` : "No print reports found yet."}</p>
              <div className="search-actions">
                <button className="search-choose" disabled={busy} onClick={() => void onDownload(r.id)}>{busy ? "Working…" : `Choose this one (${i + 1})`}</button>
                <a href={r.pageUrl} target="_blank" rel="noreferrer">Page</a>
              </div>
            </div>
          </article>
        );
      })}
      <div className="search-status">None right? Ask for a Meshy model instead (credits only after you say yes).</div>
    </div>
  );
}
