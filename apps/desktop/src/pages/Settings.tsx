import { useEffect, useState } from "react";
import type { AppSettings, SystemInfo } from "@morphix/shared";
import { api } from "../bridge";
import { speakerTest } from "../audio";
import { NetworkPanel } from "./Network";
import { useTheme, type ThemeChoice } from "../theme";
import { SystemSetup, useSetupSession } from "./setup";

const KEY_LABELS: Record<keyof AppSettings["keys"], string> = {
  gemini: "Gemini", meshy: "Meshy", claude: "Claude",
};

export function SettingsPage({ settings, onError }: { settings: AppSettings | null; onError: (m: string) => void }) {
  const [tab, setTab] = useState<"general" | "network" | "system">("general");
  return (
    <div className="page">
      <div className="tabs">
        <button className={tab === "general" ? "on" : ""} onClick={() => setTab("general")}>General</button>
        <button className={tab === "network" ? "on" : ""} onClick={() => setTab("network")}>Network</button>
        <button className={tab === "system" ? "on" : ""} onClick={() => setTab("system")}>System setup</button>
      </div>
      <div className="tab-body">
        {tab === "general" ? <General settings={settings} onError={onError} /> : tab === "network" ? <NetworkPanel onError={onError} /> : <SystemSetup />}
      </div>
    </div>
  );
}

function General({ settings, onError }: { settings: AppSettings | null; onError: (m: string) => void }) {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [balance, setBalance] = useState<string>("–");
  const [gemini, setGemini] = useState<string | null>(null);

  const refresh = () => {
    api.getSystemInfo().then(setSys);
    api.recentLogs(80).then(setLogs);
    if (settings?.keys.meshy) api.meshyBalance().then((r) => setBalance("balance" in r ? `${r.balance} credits` : r.error));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [settings?.keys.meshy]);

  const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
  const ai = settings?.ai;
  const theme = useTheme();
  const setup = useSetupSession();
  const THEMES: [ThemeChoice, string][] = [["auto", "🌗 Auto"], ["light", "☀️ Light"], ["dark", "🌙 Dark"]];
  return (
    <div className="settings-grid">
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <h3>Look</h3>
        <div className="seg">
          {THEMES.map(([c, label]) => (
            <button key={c} className={theme.choice === c ? "on" : ""} onClick={() => theme.set(c)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>AI</h3>
        <div className="stat"><span className="muted">Voice</span><span>{ai?.assistant === "gemini-live" ? `Gemini Live · ${ai.geminiModel}` : "Demo"}</span></div>
        <div className="stat"><span className="muted">3D models</span><span>{ai?.generator === "meshy" ? `Meshy · ${ai.meshyModel}` : "Demo shapes"}</span></div>
        {ai?.generator === "meshy" && (
          <>
            <div className="stat"><span className="muted">Meshy credits</span><span>{balance}</span></div>
            <div className="stat"><span className="muted">Cost</span><span>{ai.previewCredits} per model</span></div>
            <div className="stat"><span className="muted">Today</span><span>{ai.usedToday} of {ai.dailyLimit} jobs</span></div>
          </>
        )}
        {ai?.assistant === "gemini-live" && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" style={{ minHeight: 44 }} onClick={() => { setGemini("Testing…"); void api.testGemini().then((r) => setGemini(r.message)); }}>Test Gemini</button>
            {gemini && <span className="muted small">{gemini}</span>}
          </div>
        )}
      </div>
      <div className="card">
        <h3>API keys</h3>
        {settings &&
          (Object.keys(KEY_LABELS) as (keyof AppSettings["keys"])[]).map((k) => (
            <div className="stat" key={k}>
              <span className="muted">{KEY_LABELS[k]}</span>
              <span style={{ color: settings.keys[k] ? "var(--ok)" : "var(--muted)" }}>{settings.keys[k] ? "Key present" : "Not configured"}</span>
            </div>
          ))}
        <div className="muted small" style={{ marginTop: 6 }}>
          {setup.available
            ? "Keys stay on the Morphix machine and never reach this screen. Change them under System setup."
            : `Keys live in ${settings?.storageRoot ?? "~/Morphix"}/config/morphix.env on the Pi and never reach this screen.`}
        </div>
      </div>
      <div className="card">
        <h3>🌐 Use it from other devices</h3>
        <div className="muted small">Open <b>{typeof location !== "undefined" && location.protocol.startsWith("http") ? location.origin : "http://<this machine>:8080"}</b> in any browser on the same network and sign in.</div>
      </div>
      <div className="card">
        <h3>Storage</h3>
        <div className="stat"><span className="muted">Location</span><span className="small">{sys?.storageRoot ?? "–"}</span></div>
        <div className="stat"><span className="muted">Free space</span><span>{sys ? `${gb(sys.freeBytes)} of ${gb(sys.totalBytes)}` : "–"}</span></div>
        <div className="stat"><span className="muted">App version</span><span>{sys?.version ?? "–"} · {sys?.arch}</span></div>
      </div>
      <div className="card">
        <h3>Audio & printer</h3>
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="btn" style={{ minHeight: 44 }} onClick={() => void speakerTest().catch((e) => onError(String(e)))}>Test speaker</button>
          <button className="btn" style={{ minHeight: 44 }} onClick={() => void api.guardianSimulate().then((r) => (r.ok ? undefined : onError(r.message))).catch((e) => onError(String(e)))}>
            Test the print warning
          </button>
          <span className="muted small">Mic: hold the button, then ▶ Play recording.</span>
        </div>
        <div className="stat"><span className="muted">Printer</span><span>{settings?.printerHost} · every {settings?.printerPollSeconds}s</span></div>
        <div className="stat"><span className="muted">Print controls</span><span style={{ color: "var(--warn)" }}>Disabled</span></div>
      </div>
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Recent log</h3>
          <button className="btn ghost" style={{ minHeight: 40 }} onClick={refresh}>Refresh</button>
        </div>
        <div className="logs">{logs.join("\n") || "No log entries yet."}</div>
      </div>
    </div>
  );
}
