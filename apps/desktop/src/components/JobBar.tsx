// One progress bar for everything Morphix is doing (models, preparing, printing).
import { useEffect, useState } from "react";
import type { JobView } from "@morphix/shared";
import { api } from "../bridge";

const ACTIVE = new Set(["pending", "running", "waiting_for_user"]);
const ICON: Record<string, string> = { done: "✅", running: "⏳", waiting_for_user: "✋", failed: "❌", skipped: "➖", pending: "○" };

export function JobBar() {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.jobs().then(setJobs).catch(() => {});
    return api.onAppEvent((e) => {
      if (e.type !== "job") return;
      setJobs((list) => {
        const rest = list.filter((j) => j.id !== e.job.id);
        return [...rest, e.job].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-20);
      });
    });
  }, []);

  const recent = [...jobs].reverse().filter((j) => !dismissed.has(j.id));
  const job = recent.find((j) => ACTIVE.has(j.status)) ?? recent.find((j) => Date.now() - Date.parse(j.updatedAt) < 20_000);
  if (!job) return null;
  const stage = job.stages.find((s) => s.key === job.currentStage);
  const failed = job.status === "failed" || job.status === "interrupted";
  const done = job.status === "done";

  return (
    <>
      <button className={`jobbar ${failed ? "bad" : done ? "good" : ""}`} onClick={() => setOpen(true)}>
        <span className="jobbar-emoji">{failed ? "😟" : done ? "🎉" : job.status === "waiting_for_user" ? "✋" : "⏳"}</span>
        <span className="jobbar-text">
          <b>{job.title}</b> · {failed ? job.error?.title ?? "Something went wrong" : done ? "All done!" : stage?.label ?? "Working…"}
        </span>
        <span className="jobbar-track"><span style={{ width: `${job.percent}%` }} /></span>
        <span className="jobbar-pct">{job.percent}%</span>
      </button>
      {open && (
        <div className="modal-backdrop" data-no-drag-scroll onClick={() => setOpen(false)}>
          <div className="confirm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontSize: 21, fontWeight: 900 }}>{job.title}</div>
              <span className="chip">{job.percent}%</span>
            </div>
            <div className="progress big" style={{ margin: "10px 0" }}><div style={{ width: `${job.percent}%` }} /></div>
            <div className="stage-list">
              {job.stages.filter((s) => s.status !== "skipped" && s.key !== "done").map((s) => (
                <div key={s.key} className={`stage ${s.status}`}>
                  <span>{ICON[s.status] ?? "○"}</span>
                  <span style={{ flex: 1 }}>{s.label}{s.detail ? <span className="muted small"> · {s.detail}</span> : null}</span>
                  {s.status === "running" && s.progress > 0 && <span className="muted small">{s.progress}%</span>}
                </div>
              ))}
            </div>
            {job.error && (
              <div className="friendly-error" style={{ marginTop: 10 }}>
                <span style={{ fontSize: 26 }}>😟</span>
                <div>
                  <div style={{ fontWeight: 800 }}>{job.error.title}</div>
                  <div className="small">{job.error.hint}</div>
                  <div className="code">Error code {job.error.code}</div>
                </div>
              </div>
            )}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              {!ACTIVE.has(job.status) && <button className="btn ghost" onClick={() => { setDismissed((d) => new Set(d).add(job.id)); setOpen(false); }}>Hide</button>}
              <button className="btn primary" onClick={() => setOpen(false)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
