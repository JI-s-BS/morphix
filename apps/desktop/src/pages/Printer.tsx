import { useEffect, useState } from "react";
import type { AppSettings, GuardianView, PrintControlStatus, PrinterStatus } from "@morphix/shared";
import { api } from "../bridge";
import { ask } from "../components/ConfirmDialog";

const ALERT_COLORS: Record<string, string> = {
  possible_failure: "var(--warn)", confirmed_failure: "var(--bad)", pause_requested: "var(--bad)",
  pause_confirmed: "var(--ok)", pause_unconfirmed: "var(--bad)",
};

/** "1 h 12 min", "12 min", "less than a minute". */
function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const PHASE_LABEL: Record<string, string> = {
  printing: "Printing", paused: "Paused", completed: "All done! 🎉", cancelled: "Cancelled", failed: "Stopped with a problem",
};

export function PrinterPage({ status, settings, onOpenControl, onError }: {
  status: PrinterStatus | null;
  settings: AppSettings | null;
  onOpenControl: () => void;
  onError: (m: string) => void;
}) {
  const [camError, setCamError] = useState(false);
  const [camKey, setCamKey] = useState(0);
  const [guardian, setGuardian] = useState<GuardianView | null>(null);
  const [control, setControl] = useState<PrintControlStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.guardian().then(setGuardian);
    api.printStatus().then(setControl);
    // Time left changes even when progress doesn't: refresh it while a print runs.
    const tick = window.setInterval(() => void api.printStatus().then(setControl).catch(() => {}), 15_000);
    const off = api.onAppEvent((e) => {
      if (e.type === "guardian") setGuardian(e.snapshot);
      if (e.type === "print-status") setControl(e.status);
    });
    return () => {
      window.clearInterval(tick);
      off();
    };
  }, []);

  const g = async (cmd: Parameters<typeof api.guardianCommand>[0]) => {
    try {
      setGuardian(await api.guardianCommand(cmd));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const act = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      setMessage(r.message);
      if (!r.ok) onError(r.message);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const t = status?.temps;
  const job = control?.job;
  const ended = job ? ["completed", "cancelled", "failed"].includes(job.phase) : false;
  const alert = guardian?.alert;
  const spoken = guardian?.voice ?? null;
  // "Yes, stop it" / "No, keep printing" — the same answers the voice accepts.
  const answer = (d: "stop" | "keep") => act(() => api.guardianAnswer(d));
  return (
    <div className="printer">
      <div style={{ position: "relative", minHeight: 0 }}>
        {settings && !camError ? (
          <img key={camKey} className="camera" src={settings.cameraStreamUrl} alt="QD330 live camera" onError={() => setCamError(true)} />
        ) : (
          <div className="empty card" style={{ height: "100%" }}>
            <div>
              <div style={{ fontWeight: 650 }}>{camError ? "Camera not reachable" : "Loading camera…"}</div>
              {camError && <button className="btn" style={{ marginTop: 10 }} onClick={() => { setCamError(false); setCamKey((k) => k + 1); }}>Retry</button>}
            </div>
          </div>
        )}
        <div className="overlay">
          <span className="chip"><span className="dot bad" />LIVE</span>
          {guardian?.running && <span className="chip"><span className={`dot ${alert ? "bad" : "ok"}`} />Guardian · {guardian.label}</span>}
        </div>
      </div>
      <aside className="side">
        {job && job.phase !== "idle" && (
          <div className="card">
            <h3>{ended ? "Last print" : "Printing now 🖨️"}</h3>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small">{job.fileName}</span>
              <span style={{ fontWeight: 700 }}>{job.progress}%</span>
            </div>
            <div className="progress" style={{ margin: "8px 0" }}><div style={{ width: `${job.progress}%` }} /></div>
            <div className="muted small">{PHASE_LABEL[job.phase] ?? job.phase}{job.layer[1] ? ` · layer ${job.layer[0]}/${job.layer[1]}` : ""}{job.offline ? " · printer offline" : ""}</div>
            {!ended && (
              <div style={{ marginTop: 6 }}>
                {job.remainingS != null ? (
                  <>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>⏱️ About {fmtDuration(job.remainingS)} left</div>
                    {job.remainingS >= 60 && (
                      <div className="muted small">
                        Done around {new Date(Date.now() + job.remainingS * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        {job.elapsedS != null ? ` · printing for ${fmtDuration(job.elapsedS)}` : ""}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="muted small">⏱️ Working out the time left…</div>
                )}
              </div>
            )}
            {ended ? null : control?.enabled ? (
              <>
                <div className="row" style={{ marginTop: 8 }}>
                  {job.phase === "paused" ? (
                    <button className="btn" disabled={busy} onClick={async () => (await ask("Make sure the bed is clear of hands and tools.", { title: "Resume printing?", ok: "Resume", icon: "▶️" })) && void act(api.resumePrint)}>Resume print</button>
                  ) : (
                    <button className="btn" disabled={busy} onClick={() => void act(api.pausePrint)}>Pause print</button>
                  )}
                  <button className="btn danger-btn" disabled={busy} onClick={async () => (await ask("It can't be continued afterwards.", { title: "End this print?", ok: "End print", danger: true, icon: "🛑" })) && void act(api.cancelPrint)}>End print</button>
                </div>
                {job.phase === "paused" && (
                  <button className="btn ghost" style={{ marginTop: 6, minHeight: 40 }} onClick={onOpenControl}>🎛️ Open Control (filament, heat, light…)</button>
                )}
              </>
            ) : (
              <div className="muted small" style={{ marginTop: 6 }}>Use the printer's screen to pause or end the print.</div>
            )}
            {(message || control?.lastMessage) && <div className="muted small" style={{ marginTop: 6 }}>{message || control?.lastMessage}</div>}
          </div>
        )}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>🛡️ Print Guardian</h3>
            <button className="btn" style={{ minHeight: 40 }} onClick={() => void g(guardian?.running ? "stop" : "start")}>{guardian?.running ? "Stop" : "Watch my print"}</button>
          </div>
          <div className="muted small" style={{ margin: "6px 0" }}>
            {guardian ? `${guardian.label} · camera ${guardian.camera}${guardian.gemini ? " · Gemini checks on" : ""}` : "–"}
          </div>
          {(alert || spoken?.simulated) && (
            <div className="alert-box" style={{ borderColor: ALERT_COLORS[alert?.state ?? "confirmed_failure"] ?? "var(--line)" }}>
              {alert && !spoken?.simulated ? (
                <div style={{ fontWeight: 700, color: ALERT_COLORS[alert.state] }}>{alert.kind} · {alert.state.replaceAll("_", " ")}</div>
              ) : (
                <div style={{ fontWeight: 700, color: ALERT_COLORS.confirmed_failure }}>🧪 Test warning · no printer commands are sent</div>
              )}
              {alert?.explanation && !spoken?.simulated && <div className="small" style={{ marginTop: 4 }}>{alert.explanation}</div>}
              {alert && !spoken?.simulated && alert.evidenceUrls.length > 0 && <img className="evidence" src={alert.evidenceUrls[alert.evidenceUrls.length - 1]} alt="evidence" />}
              {spoken && (
                <div className="small" style={{ marginTop: 6 }}>
                  {spoken.awaitingAnswer
                    ? <>🔊 Stop the print? Say <b>“yes, stop it”</b> or <b>“no, keep printing”</b> (hold the mic), or tap below.</>
                    : "Working on your answer…"}
                  {spoken.lastSpokenBy === "none" && <div style={{ color: "var(--bad)" }}>The speaker couldn't play the warning — please read this screen.</div>}
                </div>
              )}
              <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
                {spoken ? (
                  <>
                    <button className="btn danger-btn" style={{ minHeight: 42 }} disabled={!spoken.awaitingAnswer} onClick={() => void answer("stop")}>Yes, stop it</button>
                    <button className="btn ghost" style={{ minHeight: 42 }} disabled={!spoken.awaitingAnswer} onClick={() => void answer("keep")}>No, keep printing</button>
                  </>
                ) : (
                  <button className="btn ghost" style={{ minHeight: 42 }} onClick={() => void g("dismiss")}>It's fine</button>
                )}
                {alert && !spoken?.simulated && alert.state !== "pause_confirmed" && (
                  <button className="btn" style={{ minHeight: 42 }} onClick={() => void g("requestPause")}>{guardian?.pauseAvailable ? "Pause print" : "How to pause"}</button>
                )}
                {alert && !spoken?.simulated && <button className="btn ghost" style={{ minHeight: 42 }} onClick={() => void g("resolve")}>Resolved</button>}
              </div>
            </div>
          )}
          {guardian?.running && !alert && (
            <button className="btn ghost" style={{ minHeight: 40, marginTop: 4 }} onClick={() => void g("resetBaseline")}>Re-learn scene</button>
          )}
        </div>
        <div className="card">
          <h3>Status</h3>
          <div className="stat"><span className="muted">Connection</span><span style={{ color: status?.online ? "var(--ok)" : "var(--bad)" }}>{status?.online ? "Online" : "Offline"}</span></div>
          <div className="stat"><span className="muted">State</span><span>{status?.machine ?? "–"}</span></div>
          <div className="stat"><span className="muted">Nozzle / Bed</span><span>{t?.nozzle ? `${t.nozzle.current.toFixed(0)}°` : "–"} / {t?.bed ? `${t.bed.current.toFixed(0)}°` : "–"}</span></div>
          <div className="stat"><span className="muted">Print control</span><span style={{ color: control?.enabled ? "var(--ok)" : "var(--warn)" }}>{control?.enabled ? "Enabled" : "Locked"}</span></div>
        </div>
      </aside>
    </div>
  );
}
