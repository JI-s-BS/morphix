import { useEffect, useState } from "react";
import type { NetworkStatus, WifiNetwork } from "@morphix/shared";
import { api } from "../bridge";
import { TextEntry } from "../components/Keyboard";

const bars = (signal: number) => (signal >= 75 ? "▂▄▆█" : signal >= 50 ? "▂▄▆" : signal >= 25 ? "▂▄" : "▂");

export function NetworkPanel({ onError }: { onError: (m: string) => void }) {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [askPassword, setAskPassword] = useState<WifiNetwork | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => api.networkStatus().then(setStatus).catch((e) => onError((e as Error).message));
  const scan = async () => {
    setScanning(true);
    try {
      setNetworks(await api.wifiScan());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    void refresh();
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (n: WifiNetwork, password: string | null) => {
    setBusy(n.ssid);
    setMessage(`Connecting to ${n.ssid}…`);
    const r = await api.wifiConnect(n.ssid, password);
    setBusy(null);
    setMessage(r.message);
    if (!r.ok) onError(r.message);
    void refresh();
    void scan();
  };
  const tap = (n: WifiNetwork) => {
    if (n.inUse || busy) return;
    const open = !n.security || n.security === "--";
    if (open || n.saved) void connect(n, null);
    else setAskPassword(n);
  };
  const forget = async (n: WifiNetwork) => {
    const r = await api.wifiForget(n.ssid);
    setMessage(r.message);
    if (!r.ok) onError(r.message);
    void scan();
  };

  return (
    <div className="settings-grid">
      <div className="card">
        <h3>Connection</h3>
        <div className="stat"><span className="muted">Device name</span><span>{status?.hostname ?? "–"}</span></div>
        <div className="stat"><span className="muted">Wi-Fi</span><span>{status?.wifi?.ssid ?? (status ? "Not connected" : "–")}</span></div>
        <div className="stat"><span className="muted">Wi-Fi address</span><span>{status?.wifi?.ip ?? "–"}</span></div>
        <div className="stat"><span className="muted">Signal</span><span>{status?.wifi?.signal != null ? `${status.wifi.signal}%` : "–"}</span></div>
        {message && <div className="muted small" style={{ marginTop: 8 }}>{message}</div>}
      </div>
      <div className="card">
        <h3>Printer link</h3>
        <div className="stat"><span className="muted">Port</span><span>{status?.ethernet?.device ?? "–"}</span></div>
        <div className="stat"><span className="muted">Profile</span><span>{status?.ethernet?.connection ?? "–"}</span></div>
        <div className="stat"><span className="muted">Pi address</span><span>{status?.ethernet?.ip ?? "–"}</span></div>
        <div className="muted small" style={{ marginTop: 8 }}>The QD330 cable link is fixed and can't be changed here.</div>
      </div>
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Wi-Fi networks</h3>
          <button className="btn" style={{ minHeight: 44 }} disabled={scanning} onClick={() => void scan()}>{scanning ? "Scanning…" : "Scan again"}</button>
        </div>
        <div className="muted small" style={{ marginBottom: 8 }}>Switching networks can drop remote access until the Pi reconnects.</div>
        {!networks && <div className="muted">Scanning…</div>}
        {networks?.length === 0 && <div className="muted">No networks found.</div>}
        <div className="wifi-list">
          {networks?.map((n) => (
            <div key={n.ssid} className={`wifi-row ${n.inUse ? "on" : ""}`}>
              <button className="wifi-main" onClick={() => tap(n)} disabled={Boolean(busy)}>
                <span className="wifi-bars">{bars(n.signal)}</span>
                <span className="wifi-name">{n.ssid}</span>
                <span className="muted small">{n.inUse ? "Connected" : busy === n.ssid ? "Connecting…" : n.saved ? "Saved" : n.security && n.security !== "--" ? "🔒 Secured" : "Open"}</span>
              </button>
              {n.saved && !n.inUse && <button className="btn ghost" style={{ minHeight: 44 }} onClick={() => void forget(n)}>Forget</button>}
            </div>
          ))}
        </div>
      </div>
      {askPassword && (
        <TextEntry
          title={`Password for ${askPassword.ssid}`}
          secret
          minLength={8}
          submitLabel="Connect"
          onCancel={() => setAskPassword(null)}
          onSubmit={(pw) => {
            const n = askPassword;
            setAskPassword(null);
            void connect(n, pw);
          }}
        />
      )}
    </div>
  );
}
