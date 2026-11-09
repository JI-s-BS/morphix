// Print Guardian alarm: when the camera watcher confirms a problem, a banner covers every
// page and an alarm beeps every few seconds until someone taps "I've checked" (keep printing)
// or "Stop the print". The spoken warning still plays; beeps pause while it talks.
import { useEffect, useRef, useState } from "react";
import type { GuardianVoiceView } from "@morphix/shared";
import { api } from "../bridge";
import { alertChime } from "../audio";

export const ALARM_EVERY_MS = 4_000;

export function GuardianAlarm({ speaking, onError }: { speaking: boolean; onError: (m: string) => void }) {
  const [warning, setWarning] = useState<GuardianVoiceView | null>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.guardian().then((g) => setWarning(g.voice ?? null)).catch(() => {});
    return api.onAppEvent((e) => {
      if (e.type === "guardian") setWarning(e.snapshot.voice ?? null);
    });
  }, []);

  const ringing = Boolean(warning?.awaitingAnswer);
  useEffect(() => {
    if (!ringing) return;
    const ring = () => {
      if (!speakingRef.current) void alertChime(); // don't beep over the spoken warning
    };
    ring();
    const t = window.setInterval(ring, ALARM_EVERY_MS);
    return () => window.clearInterval(t);
  }, [ringing]);

  if (!warning || !ringing) return null;
  const answer = async (d: "stop" | "keep") => {
    setBusy(true);
    try {
      const r = await api.guardianAnswer(d);
      if (!r.ok) onError(r.message);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="guardian-alarm" role="alertdialog" aria-label="Print warning">
      <div className="guardian-alarm-box">
        <div className="guardian-alarm-icon">🚨</div>
        <div className="guardian-alarm-title">{warning.simulated ? "Test alarm" : "Check your print!"}</div>
        <div className="guardian-alarm-text">{warning.problem}</div>
        <div className="guardian-alarm-actions">
          <button className="btn primary" disabled={busy} onClick={() => void answer("keep")}>✅ I've checked — keep printing</button>
          <button className="btn danger-btn" disabled={busy} onClick={() => void answer("stop")}>🛑 Stop the print</button>
        </div>
        <div className="muted small">The alarm keeps going until you tap one of these.</div>
      </div>
    </div>
  );
}
