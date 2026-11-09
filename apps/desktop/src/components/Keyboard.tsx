// On-screen keyboard for the touchscreen (no physical keyboard on the Pi).
import { useState } from "react";

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SYMBOLS = ["1234567890", "@#$%&*-+=", "!?.,:;'\"/"];
const EXTRA = ["()[]{}<>_", "\\|~^`€£"];

interface Props {
  title: string;
  initial?: string;
  secret?: boolean;
  submitLabel?: string;
  hint?: string;
  minLength?: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function TextEntry({ title, initial = "", secret = false, submitLabel = "Done", hint, minLength = 1, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const [shift, setShift] = useState(false);
  const [mode, setMode] = useState<"abc" | "123" | "#+=">("abc");
  const [show, setShow] = useState(!secret);

  const rows = mode === "abc" ? LETTERS.map((r) => (shift ? r.toUpperCase() : r)) : mode === "123" ? SYMBOLS : EXTRA;
  const type = (k: string) => {
    setValue((v) => (v + k).slice(0, 500));
    if (shift && mode === "abc") setShift(false);
  };

  return (
    <div className="modal-backdrop" data-no-drag-scroll>
      <div className="keyboard-sheet">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ fontWeight: 650, fontSize: 17 }}>{title}</div>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
        <div className="entry">
          <span className={value ? "" : "muted"}>{value ? (show ? value : "•".repeat(value.length)) : hint ?? "Type here"}</span>
          <span className="caret" />
          {secret && (
            <button className="btn ghost entry-eye" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</button>
          )}
        </div>
        <div className="keys">
          {rows.map((r, i) => (
            <div className="key-row" key={i}>
              {i === 2 && mode === "abc" && (
                <button className={`key wide ${shift ? "on" : ""}`} onClick={() => setShift((s) => !s)}>⇧</button>
              )}
              {i === 2 && mode !== "abc" && (
                <button className="key wide" onClick={() => setMode(mode === "123" ? "#+=" : "123")}>{mode === "123" ? "#+=" : "123"}</button>
              )}
              {[...r].map((k) => (
                <button key={k} className="key" onClick={() => type(k)}>{k}</button>
              ))}
              {i === 2 && <button className="key wide" onClick={() => setValue((v) => v.slice(0, -1))}>⌫</button>}
            </div>
          ))}
          <div className="key-row">
            <button className="key wide" onClick={() => setMode(mode === "abc" ? "123" : "abc")}>{mode === "abc" ? "123" : "ABC"}</button>
            <button className="key space" onClick={() => type(" ")}>space</button>
            <button className="key wide" onClick={() => setValue("")}>Clear</button>
            <button className="key wide primary" disabled={value.length < minLength} onClick={() => onSubmit(value)}>{submitLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
