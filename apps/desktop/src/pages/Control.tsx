// Control tab: every machine control in one place (light, fan, heating, filament, moving,
// emergency stop). Locked while a print is running — pause it on the Printer tab first.
// Each button still follows the printer's own safety rules (machineCapabilities).
import { useEffect, useState } from "react";
import type { FilamentInfo, FilamentState, MachineCapability, MachineCommand, PrintControlStatus, PrinterStatus } from "@morphix/shared";
import { api } from "../bridge";
import { ask } from "../components/ConfirmDialog";

/** Within this many degrees of the target counts as hot. */
const READY_MARGIN_C = 5;
const FILAMENT_JOB = /morphix-filament-(load|unload)\.gx$/i;
// Filament chips size to their label and wrap to a new row instead of squashing long names.
const CHIP = { flex: "1 0 auto" } as const;

interface FilamentFlow {
  kind: "load" | "unload";
  /** Filament being loaded. */
  to?: FilamentInfo;
  tempC: number;
  /** The printer has reported the job running at least once. */
  seenRunning: boolean;
  done: boolean;
}

export function ControlPage({ status, onOpenPrinter, onError }: { status: PrinterStatus | null; onOpenPrinter: () => void; onError: (m: string) => void }) {
  const [control, setControl] = useState<PrintControlStatus | null>(null);
  const [caps, setCaps] = useState<Record<string, MachineCapability>>({});
  const [light, setLight] = useState(false);
  const [fan, setFan] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [fil, setFil] = useState<FilamentState | null>(null);
  const [flow, setFlow] = useState<FilamentFlow | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    api.printStatus().then(setControl).catch(() => {});
    api.filaments().then(setFil).catch(() => {});
    const loadCaps = () => api.machineCapabilities().then((list) => setCaps(Object.fromEntries(list.map((c) => [c.command, c])))).catch(() => {});
    void loadCaps();
    const t = window.setInterval(loadCaps, 3000);
    const off = api.onAppEvent((e) => {
      if (e.type === "print-status") setControl(e.status);
    });
    return () => {
      window.clearInterval(t);
      off();
    };
  }, []);

  useEffect(() => {
    if (status?.online && typeof (status as { led?: unknown }).led !== "undefined") setLight(String((status as { led?: unknown }).led) === "1");
  }, [status]);

  const phase = control?.job?.phase;
  const pausedNow = phase === "paused" || String(status?.moveMode ?? "").toUpperCase() === "PAUSED";
  // A filament load/unload job runs as a "print" on the printer, but it isn't one.
  const filamentRunning = status?.machine === "BUILDING_FROM_SD" && FILAMENT_JOB.test(status?.currentFile ?? "");
  const printing = !pausedNow && !filamentRunning && (phase === "printing" || status?.machine === "BUILDING_FROM_SD");
  const paused = pausedNow;
  const locked = !control?.enabled;

  // While printing only the light and the emergency stop stay usable.
  const ALWAYS = new Set(["setLight", "emergencyStop"]);
  // Emergency stop must work while another command runs (Home, heating…): the controller
  // drops queued commands and interrupts waits for it.
  const can = (cmd: string) => (printing && !ALWAYS.has(cmd) ? false : (caps[cmd]?.allowedNow ?? false)) && (busy === null || cmd === "emergencyStop");
  const why = (cmd: string) => (printing && !ALWAYS.has(cmd) ? "Pause the print first" : caps[cmd] && !caps[cmd].allowedNow ? caps[cmd].reason ?? "Locked" : undefined);

  const run = async (c: MachineCommand, label: string): Promise<boolean> => {
    setBusy(label);
    try {
      const r = await api.machineCommand(c);
      setMessage(r.message);
      if (!r.ok) onError(r.code ? `${r.code}|${r.message}||` : r.message);
      return r.ok;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const nozzle = status?.temps?.nozzle;
  const bed = status?.temps?.bed;
  const loaded = fil?.list.find((f) => f.id === fil.loaded) ?? null;
  const hot = flow ? (nozzle?.current ?? 0) >= flow.tempC - READY_MARGIN_C : false;

  // A filament change started some other way (voice, before an app restart): follow it too.
  useEffect(() => {
    if (flow || !filamentRunning) return;
    const kind = /unload/i.test(status?.currentFile ?? "") ? "unload" : "load";
    setFlow({ kind, tempC: nozzle?.target || loaded?.changeC || 220, seenRunning: true, done: false });
  }, [filamentRunning, flow, status, nozzle, loaded]);

  // Follow the job: running while the printer builds the filament file, done when it's READY again.
  useEffect(() => {
    if (!flow || flow.done) return;
    if (filamentRunning && !flow.seenRunning) setFlow({ ...flow, seenRunning: true });
    else if (flow.seenRunning && status?.machine === "READY") {
      setFlow({ ...flow, done: true });
      api.filaments().then(setFil).catch(() => {});
    }
  }, [status, flow, filamentRunning]);

  const startJob = async (kind: "load" | "unload", to?: FilamentInfo) => {
    setChoosing(false);
    const tempC = kind === "load" && to ? Math.max(loaded?.changeC ?? 0, to.changeC) : (loaded?.changeC ?? 220);
    const what = kind === "load"
      ? `Load ${to?.label}? The nozzle heats to ${tempC} °C, then the feeder runs for about 45 seconds. Have the filament end ready to push into the top of the print head.`
      : `Unload ${loaded?.label}? The nozzle heats to ${tempC} °C, then the feeder pulls the filament out.`;
    if (!(await ask(what, { title: kind === "load" ? `Load ${to?.label ?? "filament"}` : `Unload ${loaded?.label ?? "filament"}`, ok: kind === "load" ? "Load it" : "Unload it", icon: "🧵" }))) return;
    setBusy(kind);
    try {
      const r = await api.filamentJob(kind, to?.id);
      setMessage(r.message);
      if (!r.ok) onError(r.message);
      else setFlow({ kind, to, tempC, seenRunning: false, done: false });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const temp = (t?: { current: number; target: number }) => (t ? `${t.current.toFixed(0)}°${t.target > 0 ? ` → ${t.target.toFixed(0)}°` : ""}` : "–");

  return (
    <div className="settings-grid">
      {(printing || paused || locked) && (
        <div className="card" style={{ gridColumn: "1 / -1", borderColor: printing ? "var(--warn)" : "var(--line)" }}>
          {locked ? (
            <div>🔒 Controls are locked until a grown-up switches them on.</div>
          ) : printing ? (
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span>🖨️ A print is running. Pause it on the Printer tab to use these controls (the light and emergency stop always work).</span>
              <button className="btn" style={{ minHeight: 44 }} onClick={onOpenPrinter}>Go to Printer</button>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span>⏸️ The print is paused. Controls that are safe during a pause are on. Resume or end it on the Printer tab.</span>
              <button className="btn" style={{ minHeight: 44 }} onClick={onOpenPrinter}>Go to Printer</button>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>🔥 Heat</h3>
        <div className="stat"><span className="muted">Nozzle</span><span>{temp(nozzle)}</span></div>
        <div className="stat"><span className="muted">Bed</span><span>{temp(bed)}</span></div>
        <div className="ctl-grid" style={{ marginTop: 8 }}>
          <button className="ctl" disabled={!can("setNozzleTemp")} title={why("setNozzleTemp")}
            onClick={async () => { if (loaded && (await ask(`Nozzle ${loaded.nozzleC} °C and bed ${loaded.bedC} °C. It gets HOT — keep hands out of the printer.`, { title: `Heat up for ${loaded.label}?`, ok: "Heat up", icon: "🔥" }))) { if (await run({ cmd: "bed", celsius: loaded.bedC }, "heat")) await run({ cmd: "nozzle", celsius: loaded.nozzleC }, "heat"); } }}>
            <span className="emoji">🔥</span>Heat for {loaded?.label ?? "…"}
          </button>
          <button className="ctl" disabled={!can("setNozzleTemp") || !loaded} title={why("setNozzleTemp")}
            onClick={async () => { if (loaded && (await ask(`The nozzle gets very hot.`, { title: `Heat the nozzle to ${loaded.nozzleC} °C?`, ok: "Heat nozzle", icon: "🖊️" }))) void run({ cmd: "nozzle", celsius: loaded.nozzleC }, "nozzle"); }}>
            <span className="emoji">🖊️</span>Nozzle {loaded?.nozzleC ?? "–"}°
          </button>
          <button className="ctl" disabled={!can("setBedTemp") || !loaded} title={why("setBedTemp")}
            onClick={async () => { if (loaded && (await ask(`The bed gets hot.`, { title: `Heat the bed to ${loaded.bedC} °C?`, ok: "Heat bed", icon: "🟧" }))) void run({ cmd: "bed", celsius: loaded.bedC }, "bed"); }}>
            <span className="emoji">🟧</span>Bed {loaded?.bedC ?? "–"}°
          </button>
          <button className="ctl" disabled={!can("coolDown")} title={why("coolDown")} onClick={() => void run({ cmd: "cooldown" }, "cool")}>
            <span className="emoji">❄️</span>Cool down
          </button>
        </div>
      </div>

      <div className="card">
        <h3>🧵 Filament</h3>
        {!flow ? (
          <>
            <div className="stat"><span className="muted">In the printer</span><span style={{ fontWeight: 700 }}>{loaded?.label ?? "–"}</span></div>
            {!choosing ? (
              <div className="ctl-grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 6 }}>
                <button className="ctl" disabled={printing || locked || busy !== null || !loaded} title={printing ? "Finish or end the print first" : undefined} onClick={() => void startJob("unload")}>
                  <span className="emoji">⬆️</span>Unload {loaded?.label ?? ""}
                </button>
                <button className="ctl" disabled={printing || locked || busy !== null || !fil} title={printing ? "Finish or end the print first" : undefined} onClick={() => setChoosing(true)}>
                  <span className="emoji">⬇️</span>Load filament
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                <div className="small" style={{ fontWeight: 700 }}>Which filament are you loading?</div>
                <div className="seg" style={{ flexWrap: "wrap", marginTop: 4 }}>
                  {fil?.list.map((f) => <button key={f.id} style={CHIP} onClick={() => void startJob("load", f)}>{f.label}</button>)}
                </div>
                <button className="btn ghost" style={{ minHeight: 40, marginTop: 6 }} onClick={() => setChoosing(false)}>Back</button>
              </div>
            )}
            <div className="muted small" style={{ marginTop: 6 }}>Heats the nozzle for the filament, then runs the feeder for you.</div>
            {busy === "load" || busy === "unload" ? <div className="small" style={{ marginTop: 4 }}>Sending to the printer…</div> : null}
          </>
        ) : (
          <div>
            <div style={{ fontWeight: 700 }}>{flow.kind === "load" ? `Loading ${flow.to?.label ?? "filament"}` : `Unloading ${loaded?.label ?? "filament"}`}</div>
            {flow.done ? (
              <div className="small" style={{ marginTop: 6 }}>
                ✅ {flow.kind === "load" ? `Done! ${flow.to?.label ?? "The filament"} is loaded. Clean plastic should have come out of the nozzle — pull the blob off once it's cool.` : "Done! Pull the filament end out of the top of the print head."}
                {flow.kind === "load" && flow.to?.notes.map((n) => <div key={n} className="muted" style={{ marginTop: 4 }}>{n}</div>)}
              </div>
            ) : !flow.seenRunning ? (
              <div className="small" style={{ marginTop: 6 }}>Starting on the printer…</div>
            ) : !hot ? (
              <>
                <div className="progress" style={{ margin: "8px 0" }}>
                  <div style={{ width: `${Math.min(100, Math.round(((nozzle?.current ?? 0) / flow.tempC) * 100))}%` }} />
                </div>
                <div className="small">Heating to {flow.tempC} °C… now {nozzle ? `${nozzle.current.toFixed(0)} °C` : "–"}. Don't touch the nozzle — it gets very hot!</div>
              </>
            ) : (
              <div className="small" style={{ marginTop: 6 }}>
                {flow.kind === "load"
                  ? <>🔄 The feeder is running — <b>push the filament end into the top of the print head</b> until the motor grabs it. Plastic will come out of the nozzle.</>
                  : <>🔄 The feeder is pulling the filament out…</>}
              </div>
            )}
            <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
              {flow.done ? (
                <>
                  <button className="btn" style={{ minHeight: 44 }} onClick={() => setFlow(null)}>OK</button>
                  <button className="btn ghost" style={{ minHeight: 44 }} disabled={busy !== null || !can("coolDown")} title={why("coolDown")}
                    onClick={async () => { if (await run({ cmd: "cooldown" }, "cool")) setFlow(null); }}>Cool down</button>
                </>
              ) : (
                <button className="btn danger-btn" style={{ minHeight: 44 }} disabled={busy !== null}
                  onClick={async () => { if (await ask("The feeder stops and the nozzle cools down.", { title: "Stop the filament change?", ok: "Stop it", danger: true })) { const r = await api.cancelPrint(); setMessage(r.message); if (r.ok) setFlow(null); else onError(r.message); } }}>Stop</button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>💡 Light & fan</h3>
        <div className="ctl-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button className={`ctl ${light ? "on" : ""}`} disabled={!can("setLight")} title={why("setLight")}
            onClick={async () => { if (await run({ cmd: "light", on: !light }, "light")) setLight(!light); }}>
            <span className="emoji">💡</span>Light {light ? "on" : "off"}
          </button>
          <button className={`ctl ${fan ? "on" : ""}`} disabled={!can("setFan")} title={why("setFan")}
            onClick={async () => { if (await run({ cmd: "fan", percent: fan ? 0 : 100 }, "fan")) setFan(!fan); }}>
            <span className="emoji">🌀</span>Fan {fan ? "on" : "off"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>🏠 Move</h3>
        <div className="ctl-grid">
          <button className="ctl" disabled={!can("home")} title={why("home")} onClick={() => void run({ cmd: "home" }, "home")}>
            <span className="emoji">🏠</span>Home
          </button>
          <button className="ctl" disabled={!can("motorsOff")} title={why("motorsOff")} onClick={() => void run({ cmd: "motorsOff" }, "motors")}>
            <span className="emoji">🔓</span>Motors off
          </button>
          <button className="ctl danger" disabled={!can("emergencyStop")} title={why("emergencyStop")}
            onClick={async () => { if (await ask("This ends any print and turns the heaters off.", { title: "Emergency stop?", ok: "STOP", danger: true, icon: "🛑" })) void run({ cmd: "stop" }, "stop"); }}>
            <span className="emoji">🛑</span>Emergency stop
          </button>
        </div>
      </div>

      {(busy || message) && (
        <div className="muted small" style={{ gridColumn: "1 / -1" }}>{busy ? "Working on it…" : message}</div>
      )}
    </div>
  );
}
