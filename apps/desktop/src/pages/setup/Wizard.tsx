// First-run wizard: 1 admin account, 2 printer, 3 slicer, 4 API keys, 5 done.
import { useEffect, useState, type FormEvent } from "react";
import { call, resetCsrf, type Status } from "./api";
import { Field, KeysPanel, Msg, PrinterList, SlicerPicker, useAction } from "./parts";

const STEPS = ["Admin", "Printer", "Slicer", "API keys", "Done"];
const SLICER_NAMES: Record<string, string> = { prusaslicer: "PrusaSlicer", orcaslicer: "OrcaSlicer", bambustudio: "Bambu Studio" };

export function Wizard({ setupOpen, onSession, onFinished }: { setupOpen: boolean; onSession: () => Promise<void>; onFinished: () => Promise<void> }) {
  const [step, setStep] = useState(setupOpen ? 0 : 1);
  useEffect(() => {
    if (!setupOpen && step === 0) setStep(1); // admin made (maybe on another device): move on
  }, [setupOpen, step]);
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  return (
    <div className="su-screen">
      <div className="su-wrap">
        <div className="su-brand"><span>Morphix</span> setup</div>
        <div className="su-steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => <div key={s} className={i === step ? "on" : i < step ? "done" : ""}>{s}</div>)}
        </div>
        {step === 0 && <AdminStep onDone={async () => { await onSession(); setStep(1); }} />}
        {step === 1 && (
          <>
            <Intro title="Connect your printer" text="Pick your printer's brand and model, enter how to reach it on your network, and test the connection. You can add more printers later." />
            <PrinterList />
            <Nav onBack={undefined} onNext={next} nextLabel="Continue" skip />
          </>
        )}
        {step === 2 && (
          <>
            <Intro title="Choose a slicer" text="PrusaSlicer works for most printers; Bambu Lab printers need OrcaSlicer or Bambu Studio." />
            <SlicerPicker />
            <Nav onBack={back} onNext={next} nextLabel="Continue" skip />
          </>
        )}
        {step === 3 && (
          <>
            <Intro title="Add AI keys (optional)" text="Morphix prints without any of these. Each key adds one thing it can do, and you can add them any time in Settings → System setup." />
            <KeysPanel />
            <Nav onBack={back} onNext={next} nextLabel="Continue" skip />
          </>
        )}
        {step === 4 && <DoneStep onBack={back} onFinished={onFinished} />}
      </div>
    </div>
  );
}

function Intro({ title, text }: { title: string; text: string }) {
  return (
    <div className="su-card">
      <h2>{title}</h2>
      <p className="su-lead">{text}</p>
    </div>
  );
}

function Nav({ onBack, onNext, nextLabel, skip }: { onBack?: () => void; onNext: () => void; nextLabel: string; skip?: boolean }) {
  return (
    <div className="su-actions">
      {onBack && <button className="btn ghost" onClick={onBack}>Back</button>}
      <span className="spacer" />
      {skip && <span className="muted small">You can change this later.</span>}
      <button className="btn primary" onClick={onNext}>{nextLabel}</button>
    </div>
  );
}

function AdminStep({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("admin");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const a = useAction();
  const mismatch = again.length > 0 && password !== again;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await call("POST", "/api/auth/setup", { name: name.trim(), password });
      resetCsrf();
      await onDone();
    });
  };
  return (
    <form className="su-card" onSubmit={submit}>
      <h2>Welcome! First, an admin account</h2>
      <p className="su-lead">
        Anyone on your network can open this page, so Morphix needs a password before it lets people change settings or use the printer.
        Pick one you don't use anywhere else.
      </p>
      <Field label="User name" help="Letters, digits, dots, dashes or underscores.">
        <input className="su-input" autoCapitalize="none" autoComplete="username" maxLength={32} aria-invalid={a.field === "name"} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Password" help="At least 8 characters. A short sentence is easy to remember and hard to guess.">
        <input className="su-input" type="password" autoComplete="new-password" aria-invalid={a.field === "password"} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Password again">
        <input className="su-input" type="password" autoComplete="new-password" aria-invalid={mismatch} value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {mismatch && <Msg kind="warn" text="The two passwords don't match." />}
      {a.error && <Msg kind="bad" text={a.error} />}
      <div className="su-actions">
        <button className="btn primary" disabled={a.busy || !name.trim() || password.length < 8 || password !== again}>{a.busy ? "Creating…" : "Create admin account"}</button>
      </div>
    </form>
  );
}

function DoneStep({ onBack, onFinished }: { onBack: () => void; onFinished: () => Promise<void> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const a = useAction();
  useEffect(() => {
    void a.run(async () => setStatus(await call<Status>("GET", "/api/setup/status")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const keys = Object.values(status?.keys ?? {}).filter(Boolean).length;
  return (
    <div className="su-card">
      <h2>All set 🎉</h2>
      {status && (
        <>
          <div className="stat"><span className="muted">Admin account</span><span style={{ color: "var(--ok)" }}>Created</span></div>
          <div className="stat"><span className="muted">Printers</span><span style={{ color: status.printers ? "var(--ok)" : "var(--warn)" }}>{status.printers ? `${status.printers} connected` : "None yet"}</span></div>
          <div className="stat"><span className="muted">Slicer</span><span style={{ color: status.slicer ? "var(--ok)" : "var(--warn)" }}>{status.slicer ? SLICER_NAMES[status.slicer] ?? status.slicer : "Not chosen"}</span></div>
          <div className="stat"><span className="muted">AI keys</span><span>{keys ? `${keys} set` : "None (that's fine)"}</span></div>
          {!status.printers && <Msg kind="warn" text="Without a printer you can make and view models but not print them." hint="Add one any time in Settings → System setup." />}
          {status.issues?.map((i) => <Msg key={i} kind="warn" text={i} />)}
          <Msg kind="ok" text="After you start, restart Morphix once so it uses this printer and these keys: run morphix restart on the Morphix machine (or reboot it)." />
        </>
      )}
      {a.error && <Msg kind="bad" text={a.error} />}
      <div className="su-actions">
        <button className="btn ghost" onClick={onBack}>Back</button>
        <span className="spacer" />
        <button className="btn primary" disabled={a.busy} onClick={() => void a.run(async () => { await call("POST", "/api/setup/finish"); await onFinished(); })}>Start using Morphix</button>
      </div>
    </div>
  );
}
