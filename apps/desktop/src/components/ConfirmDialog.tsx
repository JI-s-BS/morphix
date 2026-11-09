// Touch-friendly confirmation: big buttons instead of the system confirm() pop-up, whose
// tiny OK/Cancel are hard to hit on the Pi touchscreen. `await ask("Heat up?")` anywhere;
// <ConfirmHost /> (mounted once in App) shows it.
import { useEffect, useState } from "react";

export interface AskOptions {
  title?: string;
  /** Label for the yes button (default "Yes"). */
  ok?: string;
  /** Label for the no button (default "Cancel"). */
  cancel?: string;
  /** Red yes button for things that stop or end something. */
  danger?: boolean;
  icon?: string;
}

interface Request {
  message: string;
  opts: AskOptions;
  resolve: (yes: boolean) => void;
}

let show: ((r: Request) => void) | null = null;

/** Asks the user; resolves true only when they tap the yes button. */
export function ask(message: string, opts: AskOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(window.confirm(message)); // host not mounted (tests, preview)
    show({ message, opts, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);

  useEffect(() => {
    show = (r) =>
      setReq((prev) => {
        prev?.resolve(false); // a newer question replaces an unanswered one
        return r;
      });
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
      if (e.key === "Enter") answer(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!req) return null;
  const { message, opts } = req;
  function answer(yes: boolean) {
    req?.resolve(yes);
    setReq(null);
  }
  return (
    <div className="confirm-back" onPointerDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div className={`confirm-box ${opts.danger ? "danger" : ""}`} role="alertdialog" aria-modal="true" aria-label={opts.title ?? message}>
        <div className="confirm-icon">{opts.icon ?? (opts.danger ? "⚠️" : "❓")}</div>
        {opts.title && <div className="confirm-title">{opts.title}</div>}
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="btn" onClick={() => answer(false)}>{opts.cancel ?? "Cancel"}</button>
          <button className={`btn ${opts.danger ? "danger-btn solid" : "primary"}`} onClick={() => answer(true)} autoFocus>{opts.ok ?? "Yes"}</button>
        </div>
      </div>
    </div>
  );
}
