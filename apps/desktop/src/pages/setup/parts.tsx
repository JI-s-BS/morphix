// Building blocks shared by the first-run wizard and Settings → System setup:
// sign-in, password change, printer editor, slicer picker, API keys, features, accounts.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { ConnectionField } from "@morphix/printer";
import {
  ApiError, call, errorText, resetCsrf, type Catalog, type CatalogModel, type Features, type FoundPrinter, type KeyInfo, type KeyTest, type SavedPrinter,
  type SessionUser, type SlicerChoice, type TestResult,
} from "./api";

/** The server reads printers, keys and the slicer at start-up (until it learns to reload them). */
export const RESTART_NOTE = "Saved. Restart Morphix to use the change: run morphix restart on the Morphix machine (or reboot it).";

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="su-field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}

export function Msg({ kind, text, hint }: { kind: "ok" | "bad" | "warn"; text: string; hint?: string }) {
  return (
    <div className={`su-msg ${kind}`} role={kind === "bad" ? "alert" : "status"}>
      {text}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Runs an async action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The input the server complained about, if it said. */
  const [field, setField] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setField(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
      setField(e instanceof ApiError && e.field ? e.field : null);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, field, setError, run };
}

// ------------------------------------------------------------------ sign-in ---
export function LoginForm({ onDone, note }: { onDone: () => void; note?: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await call("POST", "/api/auth/login", { name: name.trim(), password });
      resetCsrf();
      setPassword("");
      onDone();
    });
  };
  return (
    <form className="su-card" onSubmit={submit}>
      <h2>Sign in</h2>
      {note && <p className="su-lead">{note}</p>}
      <Field label="User name">
        <input className="su-input" autoComplete="username" autoCapitalize="none" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Password">
        <input className="su-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {a.error && <Msg kind="bad" text={a.error} />}
      <div className="su-actions">
        <button className="btn primary" disabled={a.busy || !name || !password}>{a.busy ? "Signing in…" : "Sign in"}</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Forgot the admin password? On the Morphix machine run <code>node apps/server/dist/server.cjs reset-admin</code>.
      </p>
    </form>
  );
}

export function ChangePasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  const mismatch = again.length > 0 && next !== again;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await call("POST", "/api/auth/password", { current, next });
      resetCsrf();
      setCurrent("");
      setNext("");
      setAgain("");
      setDone(true);
      onDone();
    });
  };
  return (
    <form className="su-card" onSubmit={submit}>
      <h2>{forced ? "Pick a new password" : "Change my password"}</h2>
      {forced && <p className="su-lead">Your password was reset from the command line. Choose your own before you continue.</p>}
      <Field label={forced ? "Password you were given" : "Current password"}>
        <input className="su-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" help="At least 8 characters.">
        <input className="su-input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="New password again">
        <input className="su-input" type="password" autoComplete="new-password" aria-invalid={mismatch} value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {mismatch && <Msg kind="warn" text="The two new passwords don't match." />}
      {a.error && <Msg kind="bad" text={a.error} />}
      {done && !a.error && <Msg kind="ok" text="Password changed. Other devices signed in as you were signed out." />}
      <div className="su-actions">
        <button className="btn primary" disabled={a.busy || !current || next.length < 8 || next !== again}>Change password</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ printers ---
type Values = Record<string, string | boolean>;

function initialValues(fields: ConnectionField[], saved?: SavedPrinter, prefill?: Partial<Record<string, string | number>>): Values {
  const v: Values = {};
  for (const f of fields) {
    const s = saved?.connection[f.key];
    const p = prefill?.[f.key];
    if (f.kind === "secret") v[f.key] = "";
    else if (f.kind === "boolean") v[f.key] = typeof s === "boolean" ? s : f.default === true;
    else v[f.key] = String(s ?? p ?? f.default ?? "");
  }
  return v;
}

function payloadOf(fields: ConnectionField[], values: Values): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === "") continue;
    out[f.key] = f.kind === "port" || f.kind === "number" ? (/^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v)) : v;
  }
  return out;
}

function TestOutcome({ result }: { result: TestResult }) {
  if (result.ok) {
    const info = [result.info.name, result.info.model, result.info.firmware && `firmware ${result.info.firmware}`].filter(Boolean).join(" · ");
    return <Msg kind="ok" text={`Connected${info ? `: ${info}` : ""}.`} />;
  }
  return <Msg kind="bad" text={result.message} hint={result.hint} />;
}

/**
 * Add or edit one printer: brand → model → connection fields (with help and the printer's setup
 * guide) → test → save. Also offers a LAN search that fills in the address.
 */
export function PrinterEditor({ saved, onSaved, onCancel }: { saved?: SavedPrinter; onSaved: (p: SavedPrinter) => void; onCancel?: () => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [driverId, setDriverId] = useState<string | null>(saved?.driver ?? null);
  const [name, setName] = useState(saved?.name ?? "");
  const [values, setValues] = useState<Values>({});
  const [prefill, setPrefill] = useState<Partial<Record<string, string | number>>>({});
  const [found, setFound] = useState<FoundPrinter[] | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const load = useAction();
  const act = useAction();

  useEffect(() => {
    void load.run(async () => {
      const c = await call<Catalog>("GET", "/api/setup/catalog");
      setCatalog(c);
      if (saved) {
        const m = c.brands.flatMap((b) => b.models).find((x) => x.id === saved.modelId) ?? null;
        setBrand(m?.brand ?? null);
        setModel(m);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const driver = useMemo(() => catalog?.drivers.find((d) => d.id === (driverId ?? model?.driver)) ?? null, [catalog, driverId, model]);
  useEffect(() => {
    if (driver) setValues(initialValues(driver.fields, saved && saved.driver === driver.id ? saved : undefined, prefill));
    setResult(null);
  }, [driver, saved, prefill]);

  const pickModel = (m: CatalogModel) => {
    setModel(m);
    setDriverId(m.driver);
    if (!saved || !name) setName(`${m.brand} ${m.model}`);
  };

  const search = () =>
    void act.run(async () => {
      setFound(null);
      const r = await call<{ found: FoundPrinter[] }>("POST", "/api/setup/discover", {});
      setFound(r.found);
    });

  const pickFound = (f: FoundPrinter) => {
    if (!catalog) return;
    const models = catalog.brands.flatMap((b) => b.models).filter((m) => f.models.includes(m.id));
    const exact = models.find((m) => f.model && `${m.brand} ${m.model}`.toLowerCase().includes(f.model.toLowerCase())) ?? (models.length === 1 ? models[0] : null);
    setPrefill({ host: f.host, ...(f.port ? { port: f.port } : {}), ...(f.serial ? { serial: f.serial } : {}) });
    if (exact) {
      setBrand(exact.brand);
      pickModel(exact);
      setDriverId(f.driver);
    } else if (models[0]) setBrand(models[0].brand);
    if (f.name) setName(f.name);
  };

  const body = () => ({ name: name.trim(), modelId: model!.id, driver: driver!.id, connection: payloadOf(driver!.fields, values) });

  const test = () =>
    void act.run(async () => {
      setResult(null);
      const r = saved && saved.driver === driver!.id
        ? await call<{ result: TestResult }>("POST", `/api/setup/printers/${saved.id}/test`, body())
        : await call<{ result: TestResult }>("POST", "/api/setup/test-printer", body());
      setResult(r.result);
    });

  const save = () =>
    void act.run(async () => {
      const r = saved
        ? await call<{ printer: SavedPrinter }>("PUT", `/api/setup/printers/${saved.id}`, body())
        : await call<{ printer: SavedPrinter }>("POST", "/api/setup/printers", body());
      onSaved(r.printer);
    });

  if (!catalog) return load.error ? <Msg kind="bad" text={load.error} /> : <div className="muted">Loading printers…</div>;
  const brandModels = catalog.brands.find((b) => b.brand === brand)?.models ?? [];
  const canDiscover = catalog.drivers.some((d) => d.canDiscover);

  return (
    <div className="su-card">
      <h3>{saved ? `Edit ${saved.name}` : "Add a printer"}</h3>

      {!saved && canDiscover && (
        <div className="su-row" style={{ paddingTop: 0 }}>
          <div className="grow muted small">Printer already on your network? Morphix can look for it.</div>
          <button className="btn" onClick={search} disabled={act.busy}>🔎 Search my network</button>
        </div>
      )}
      {found && (found.length === 0
        ? <Msg kind="warn" text="No printers answered." hint="Make sure the printer is on and its LAN / network mode is switched on, or pick it from the list below." />
        : (
          <div className="su-picks">
            {found.map((f) => (
              <button key={`${f.driver}-${f.host}-${f.port ?? ""}`} className="su-pick" onClick={() => pickFound(f)}>
                {f.name ?? f.model ?? f.host}
                <small>{f.host}{f.model ? ` · ${f.model}` : ""}</small>
              </button>
            ))}
          </div>
        ))}

      <Field label="1. Brand">
        <div className="su-picks">
          {catalog.brands.map((b) => (
            <button key={b.brand} type="button" className={`su-pick ${brand === b.brand ? "on" : ""}`} onClick={() => { setBrand(b.brand); setModel(null); setDriverId(null); }}>
              {b.brand}
              <small>{b.models.length} model{b.models.length === 1 ? "" : "s"}</small>
            </button>
          ))}
        </div>
      </Field>

      {brand && (
        <Field label="2. Model">
          <div className="su-picks">
            {brandModels.map((m) => (
              <button key={m.id} type="button" className={`su-pick ${model?.id === m.id ? "on" : ""}`} disabled={!m.driverAvailable && !m.altDrivers.length} onClick={() => pickModel(m)}>
                {m.model}
                <small>{m.driverAvailable || m.altDrivers.length ? (m.verified === "tested" ? "Tested with Morphix" : "Not yet tried on real hardware") : "Not supported yet"}</small>
              </button>
            ))}
          </div>
        </Field>
      )}

      {model && (
        <>
          {model.docUrl && (
            <div className="small">
              📘 <a className="su-link" href={model.docUrl} target="_blank" rel="noopener noreferrer">How to connect the {model.brand} {model.model}</a> (turn on network access, find the address and codes)
            </div>
          )}
          {model.verified === "protocol" && (
            <Msg kind="warn" text="Morphix talks to this printer from the maker's documentation but nobody has tried it on a real one yet." hint="Watch the first print and tell us how it went." />
          )}
          {model.altDrivers.length > 0 && (
            <Field label="Connect through">
              <div className="seg">
                {[model.driver, ...model.altDrivers].map((d) => {
                  const info = catalog.drivers.find((x) => x.id === d);
                  return (
                    <button key={d} type="button" className={(driverId ?? model.driver) === d ? "on" : ""} disabled={!info} onClick={() => setDriverId(d)}>
                      {info?.name ?? d}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
          {!driver && <Msg kind="bad" text="This version of Morphix can't talk to that printer yet." />}
          {driver && (
            <>
              <div className="muted small">{driver.description}</div>
              <Field label="Name for this printer" help="Anything you like, e.g. “Garage printer”.">
                <input className="su-input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              {driver.fields.map((f) => (
                <ConnectionInput key={f.key} field={f} value={values[f.key]} savedSecret={Boolean(saved?.secretFields[f.key])} invalid={act.field === f.key}
                  onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
              ))}
              {result && <TestOutcome result={result} />}
              {act.error && <Msg kind="bad" text={act.error} />}
              <div className="su-actions">
                {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
                <span className="spacer" />
                <button type="button" className="btn" onClick={test} disabled={act.busy || !name.trim()}>{act.busy ? "Working…" : "Test connection"}</button>
                <button type="button" className="btn primary" onClick={save} disabled={act.busy || !name.trim()}>{saved ? "Save changes" : "Save printer"}</button>
              </div>
            </>
          )}
        </>
      )}
      {!model && onCancel && (
        <div className="su-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function ConnectionInput({ field: f, value, onChange, savedSecret, invalid }: {
  field: ConnectionField; value: string | boolean | undefined; onChange: (v: string | boolean) => void; savedSecret: boolean; invalid: boolean;
}) {
  const label = `${f.label}${f.required ? "" : " (optional)"}`;
  if (f.kind === "boolean") {
    return (
      <Field label={label} help={f.help}>
        <div className="seg" style={{ maxWidth: 260 }}>
          <button type="button" className={value === true ? "on" : ""} onClick={() => onChange(true)}>Yes</button>
          <button type="button" className={value !== true ? "on" : ""} onClick={() => onChange(false)}>No</button>
        </div>
      </Field>
    );
  }
  const numeric = f.kind === "port" || f.kind === "number";
  const placeholder = f.kind === "secret" && savedSecret ? "Saved. Leave empty to keep it." : f.kind === "host" ? "192.168.1.50 or printer.local" : f.kind === "serial-port" ? "/dev/ttyUSB0" : typeof f.default !== "undefined" ? String(f.default) : "";
  return (
    <Field label={label} help={f.help}>
      <input
        className="su-input" aria-invalid={invalid} value={String(value ?? "")} placeholder={placeholder}
        type={f.kind === "secret" ? "password" : "text"} inputMode={numeric ? "numeric" : undefined}
        autoComplete={f.kind === "secret" ? "new-password" : "off"} autoCapitalize="none" spellCheck={false} maxLength={f.kind === "secret" ? 512 : 253}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** Saved printers with test / edit / delete / make active. */
export function PrinterList({ onChange }: { onChange?: (count: number) => void }) {
  const [list, setList] = useState<{ printers: SavedPrinter[]; activePrinterId: string | null } | null>(null);
  const [editing, setEditing] = useState<SavedPrinter | "new" | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [changed, setChanged] = useState(false);
  const a = useAction();
  const refresh = () =>
    a.run(async () => {
      const r = await call<{ printers: SavedPrinter[]; activePrinterId: string | null }>("GET", "/api/setup/printers");
      setList(r);
      onChange?.(r.printers.length);
      if (r.printers.length === 0) setEditing((e) => e ?? "new");
    });
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (editing) {
    return (
      <PrinterEditor
        saved={editing === "new" ? undefined : editing}
        onSaved={() => { setEditing(null); setChanged(true); void refresh(); }}
        onCancel={list && list.printers.length > 0 ? () => setEditing(null) : undefined}
      />
    );
  }
  return (
    <div className="su-card">
      <h3>Printers</h3>
      {!list && !a.error && <div className="muted">Loading…</div>}
      {list?.printers.map((p) => (
        <div key={p.id}>
          <div className="su-row">
            <div className="grow">
              <b>{p.name}</b> {list.activePrinterId === p.id && <span className="su-tag ok">In use</span>}
              <div className="muted small">{p.driverName}{p.connection.host ? ` · ${String(p.connection.host)}` : ""}{p.driverAvailable ? "" : " · driver not available"}</div>
            </div>
            {list.activePrinterId !== p.id && (
              <button className="btn" onClick={() => void a.run(async () => { await call("PUT", "/api/setup/active-printer", { id: p.id }); setChanged(true); await refresh(); })}>Use this one</button>
            )}
            <button className="btn" disabled={a.busy} onClick={() => void a.run(async () => {
              const r = await call<{ result: TestResult }>("POST", `/api/setup/printers/${p.id}/test`);
              setResults((cur) => ({ ...cur, [p.id]: r.result }));
            })}>Test</button>
            <button className="btn" onClick={() => setEditing(p)}>Edit</button>
            <button className="btn ghost" onClick={() => {
              if (window.confirm(`Remove ${p.name}? Its saved codes are deleted too.`)) void a.run(async () => { await call("DELETE", `/api/setup/printers/${p.id}`); setChanged(true); await refresh(); });
            }}>Remove</button>
          </div>
          {results[p.id] && <TestOutcome result={results[p.id]} />}
        </div>
      ))}
      {changed && <Msg kind="ok" text={RESTART_NOTE} />}
      {a.error && <Msg kind="bad" text={a.error} />}
      <div className="su-actions">
        <button className="btn" onClick={() => setEditing("new")}>＋ Add a printer</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ slicer ---
export function SlicerPicker({ onSaved }: { onSaved?: (id: string | null) => void }) {
  const [data, setData] = useState<{ slicers: SlicerChoice[]; preferred: string | null; paths: Record<string, string> } | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const a = useAction();
  const load = () =>
    a.run(async () => {
      const r = await call<{ slicers: SlicerChoice[]; preferred: string | null; paths: Record<string, string> }>("GET", "/api/setup/slicers");
      setData(r);
      setPaths(r.paths);
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = (preferred: string | null) =>
    void a.run(async () => {
      setSaved(false);
      const r = await call<{ preferred: string | null; paths: Record<string, string> }>("PUT", "/api/setup/slicer", { preferred, paths });
      setData((d) => (d ? { ...d, ...r } : d));
      setSaved(true);
      onSaved?.(r.preferred);
    });

  return (
    <div className="su-card">
      <h3>Slicer</h3>
      <p className="su-lead">The slicer turns a 3D model into instructions for your printer. Morphix uses one that's installed on this machine.</p>
      {!data && !a.error && <div className="muted">Looking for slicers…</div>}
      {data && (
        <div className="su-picks">
          {data.slicers.map((s) => (
            <button key={s.id} className={`su-pick ${data.preferred === s.id ? "on" : ""}`} onClick={() => save(s.id)} disabled={a.busy}>
              {s.name}
              <small>
                {s.installed === true ? `Installed${s.version ? ` · ${s.version}` : ""}` : s.installed === false ? "Not found on this machine" : "Not checked"}
                {s.supportsActivePrinter === false ? " · can't make files for your printer" : ""}
              </small>
            </button>
          ))}
        </div>
      )}
      {data?.slicers.filter((s) => s.installed === false && s.hint && data.preferred === s.id).map((s) => (
        <Msg key={s.id} kind="warn" text={`${s.name} isn't installed yet.`} hint={s.hint} />
      ))}
      {data && (
        <details>
          <summary className="muted small" style={{ minHeight: 44, display: "flex", alignItems: "center" }}>Installed somewhere unusual? Set its path</summary>
          {data.slicers.map((s) => (
            <Field key={s.id} label={`${s.name} program`}>
              <input className="su-input" placeholder="/usr/bin/…" value={paths[s.id] ?? ""} onChange={(e) => setPaths((p) => ({ ...p, [s.id]: e.target.value }))} />
            </Field>
          ))}
          <div className="su-actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => save(data.preferred)} disabled={a.busy}>Save paths</button>
          </div>
        </details>
      )}
      {saved && !a.error && <Msg kind="ok" text={RESTART_NOTE} />}
      {a.error && <Msg kind="bad" text={a.error} />}
      <div className="su-actions">
        <button className="btn ghost" onClick={() => void load()} disabled={a.busy}>Check again</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ API keys ---
export function KeysPanel({ onChange }: { onChange?: () => void }) {
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const a = useAction();
  const load = () => a.run(async () => setKeys((await call<{ keys: KeyInfo[] }>("GET", "/api/setup/keys")).keys));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="su-card">
      <h3>API keys (all optional)</h3>
      <p className="su-lead">Each key switches on one AI service. Keys stay on this machine; this screen only ever shows whether one is set.</p>
      {a.error && <Msg kind="bad" text={a.error} />}
      {keys?.map((k) => <KeyRow key={k.key} info={k} onChange={() => { void load(); onChange?.(); }} />)}
    </div>
  );
}

function KeyRow({ info, onChange }: { info: KeyInfo; onChange: () => void }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<KeyTest | null>(null);
  const a = useAction();
  const test = () =>
    void a.run(async () => {
      setResult(null);
      setResult((await call<{ result: KeyTest }>("POST", `/api/setup/keys/${info.key}/test`, value ? { value } : undefined)).result);
    });
  return (
    <div className="su-row" style={{ alignItems: "stretch", flexDirection: "column" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{info.label}</b>
        <span className={`su-tag ${info.set ? "ok" : ""}`}>{info.set ? "Set" : "Not set"}</span>
      </div>
      <div className="muted small">{info.unlocks} <a className="su-link" href={info.getUrl} target="_blank" rel="noopener noreferrer">Get a key</a></div>
      <input
        className="su-input" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={value}
        placeholder={info.set ? "Saved. Paste a new key to replace it." : `Paste your ${info.label} key`} onChange={(e) => setValue(e.target.value)}
      />
      {result && <Msg kind={result.ok ? "ok" : "bad"} text={result.message} hint={result.ok ? undefined : result.hint} />}
      {a.error && <Msg kind="bad" text={a.error} />}
      <div className="su-actions">
        {info.set && (
          <button className="btn ghost" disabled={a.busy} onClick={() => void a.run(async () => { await call("DELETE", `/api/setup/keys/${info.key}`); setResult({ ok: true, message: RESTART_NOTE.replace("Saved.", "Removed.") }); onChange(); })}>Remove</button>
        )}
        <span className="spacer" />
        <button className="btn" disabled={a.busy || (!value && !info.set)} onClick={test}>Test</button>
        <button className="btn primary" disabled={a.busy || !value} onClick={() => void a.run(async () => {
          await call("PUT", `/api/setup/keys/${info.key}`, { value });
          setValue("");
          setResult({ ok: true, message: RESTART_NOTE });
          onChange();
        })}>Save</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ features ---
const FEATURES: { key: keyof Features; label: string; text: string }[] = [
  { key: "voice", label: "Voice assistant", text: "Talk to Morphix (Gemini key)." },
  { key: "aiGeneration", label: "AI model generation", text: "Make 3D models from ideas and photos (Meshy or Claude key)." },
  { key: "modelSearch", label: "Model search", text: "Find ready-made models (Thingiverse or Gemini key)." },
  { key: "guardian", label: "Print Guardian", text: "Watch the camera for failed prints (Gemini key)." },
];

export function FeaturesPanel({ initial }: { initial?: Features }) {
  const [features, setFeatures] = useState<Features | null>(initial ?? null);
  const [changed, setChanged] = useState(false);
  const a = useAction();
  useEffect(() => {
    if (!initial) void a.run(async () => setFeatures((await call<{ features: Features }>("GET", "/api/setup/status")).features ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (k: keyof Features, v: boolean) => void a.run(async () => {
    setFeatures((await call<{ features: Features }>("PUT", "/api/setup/features", { [k]: v })).features);
    setChanged(true);
  });
  return (
    <div className="su-card">
      <h3>Features</h3>
      {features && FEATURES.map((f) => (
        <div key={f.key} className="su-row">
          <div className="grow"><b>{f.label}</b><div className="muted small">{f.text}</div></div>
          <div className="seg su-toggle">
            <button className={features[f.key] ? "on" : ""} disabled={a.busy} onClick={() => set(f.key, true)}>On</button>
            <button className={!features[f.key] ? "on" : ""} disabled={a.busy} onClick={() => set(f.key, false)}>Off</button>
          </div>
        </div>
      ))}
      {changed && !a.error && <Msg kind="ok" text={RESTART_NOTE} />}
      {a.error && <Msg kind="bad" text={a.error} />}
    </div>
  );
}

// ------------------------------------------------------------------ accounts ---
export function AccountsPanel({ me }: { me: SessionUser }) {
  const [users, setUsers] = useState<{ name: string; role: string }[] | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const a = useAction();
  const load = () => a.run(async () => setUsers((await call<{ users: { name: string; role: string }[] }>("GET", "/api/auth/users")).users));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="su-card">
      <h3>Accounts</h3>
      <p className="su-lead">Admins can change these settings. Users can make and print things but can't change settings.</p>
      {users?.map((u) => (
        <div key={u.name} className="su-row">
          <div className="grow"><b>{u.name}</b> <span className="su-tag">{u.role}</span>{u.name === me.name && <span className="muted small"> (you)</span>}</div>
          {u.name !== me.name && (
            <button className="btn ghost" onClick={() => {
              if (window.confirm(`Remove the account ${u.name}?`)) void a.run(async () => { await call("DELETE", `/api/auth/users/${encodeURIComponent(u.name)}`); await load(); });
            }}>Remove</button>
          )}
        </div>
      ))}
      <form className="su-field" onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await call("POST", "/api/auth/users", { name: name.trim(), password, role });
          setName("");
          setPassword("");
          await load();
        });
      }}>
        <span>Add an account</span>
        <input className="su-input" placeholder="User name" autoCapitalize="none" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="su-input" type="password" placeholder="Password (8+ characters)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="seg" style={{ maxWidth: 320 }}>
          <button type="button" className={role === "user" ? "on" : ""} onClick={() => setRole("user")}>User</button>
          <button type="button" className={role === "admin" ? "on" : ""} onClick={() => setRole("admin")}>Admin</button>
        </div>
        <div className="su-actions">
          <button className="btn" disabled={a.busy || !name || password.length < 8}>Add account</button>
        </div>
      </form>
      {a.error && <Msg kind="bad" text={a.error} />}
    </div>
  );
}
