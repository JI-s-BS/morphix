// Phases 3–5 in the main process: print preparation (repair, orient, slice, .gx),
// printer control behind two operator switches + per-print approval, and the
// AI Print Guardian watching the camera.
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { SlicerDefaults, FilamentState, GuardianView, GuardianVoiceView, MachineCapability, MachineCommand, PendingAction, PrepareSettings, PrepareSummary, PrintControlStatus, PrinterStatus } from "@morphix/shared";
import { transition, type WorkflowState } from "@morphix/domain";
import { clampSpeed, clampZOffset, MAX_Z_OFFSET_MM, MIN_Z_OFFSET_MM, profileZOffset,
  advisorGeminiFromEnv, changeTemperature, DEFAULT_FILAMENT, FILAMENT_IDS, FILAMENTS, filamentChangeGcode, filamentJobFileName, filamentProfile, gxThumbnailBmp,
  isFilamentId, isFilamentJobFile, prepareWithAdvice, writeGx, type FilamentChange, type FilamentId, type LevelingPlan, type PreparePrintResult,
} from "@morphix/slicing";
import { preparePrint } from "@morphix/slicing";
import { toMorphixError } from "@morphix/errors";
import { JobTracker, PrintAuthorizer, QD330Controller, detectActivePrint, isPausedStatus, remainingSeconds, type ApprovalSource, type MachineApprovalSource, type RequestedBy, type UnverifiedCommandFlags } from "@morphix/printer";
import { PrintGuardian, applyGuardianSchema, geminiVisionFromEnv, swarmsFromEnv, telemetryFromEnv, type GuardianSnapshot, type GuardianStore } from "@morphix/guardian";
import { createTigerSink } from "./tiger";
import { type Ctx, now } from "./context";
import type { Jobs } from "./jobs";

export interface PrintingOptions {
  repoRoot: string;
  printerHost: string;
  controlsEnabled: boolean;
  gxVerified: boolean;
  pausedStatuses: string[];
  /** Unverified commands the operator has switched on (MORPHIX_ALLOW_UNVERIFIED=light,fan,temperatures,motors). */
  allowUnverified: UnverifiedCommandFlags;
  /** Bed leveling before each print (default: the printer's own routine; see packages/slicing/src/leveling.ts). */
  leveling?: LevelingPlan;
}

/** Map the advisor/slicer stage names to the shared job stage keys. */
const STAGE_KEY: Record<string, string> = {
  load: "prepare.check", validate: "prepare.check", repair: "prepare.repair", place: "prepare.orient", advise: "prepare.orient",
  slice: "prepare.slice", gx: "prepare.gx",
};

const DEFAULT_SETTINGS: PrepareSettings = { layerHeightMm: 0.2, infillPercent: 15, supports: "auto" };

/** Walks the workflow through intermediate states (e.g. reviewing -> sizing -> validating). */
function walk(ctx: Ctx, projectId: string, path: WorkflowState[], flags: { printControlsEnabled?: boolean; userApproved?: boolean } = {}) {
  const r = ctx.db.get("SELECT state FROM projects WHERE id = ?", [projectId]);
  if (!r) return;
  let state = r.state as WorkflowState;
  for (const next of path) {
    if (state === next) continue;
    try {
      state = transition(state, next, flags);
    } catch {
      continue; // skip steps that don't apply from the current state
    }
  }
  ctx.db.run("UPDATE projects SET state = ?, updated_at = ? WHERE id = ?", [state, now(), projectId]);
}

export class Printing {
  readonly controller: QD330Controller;
  readonly tracker: JobTracker;
  readonly guardian: PrintGuardian;
  private authorizer = new PrintAuthorizer();
  private busy: string | null = null;
  private lastMessage: string | null = null;
  private guardianRunning = false;
  /** The operator pressed Stop on the guardian: don't auto-start it again until this print ends. */
  private guardianStoppedByUser = false;
  private activeJobId: string | null = null;
  private printJobView: string | null = null;
  jobs: Jobs | null = null;
  /** Filament being loaded by a running filament job (recorded as loaded when it ends). */
  private loadingFilament: FilamentId | null = null;
  /** Spoken-warning state (set by main.ts once the voice is wired). */
  voiceInfo: (() => GuardianVoiceView | null) | null = null;

  constructor(private ctx: Ctx, private o: PrintingOptions) {
    this.controller = new QD330Controller({
      enabled: o.controlsEnabled,
      host: o.printerHost,
      pausedStatuses: o.pausedStatuses,
      allowUnverified: o.allowUnverified,
      authorizer: this.authorizer,
      log: (e) => ctx.log.write(e.outcome === "confirmed" ? "info" : "warn", "printer-control", e),
    });
    this.tracker = new JobTracker({ pausedStatuses: o.pausedStatuses });
    this.tracker.on("change", (job) => {
      this.emitStatus();
      if (this.printJobView && job.phase === "printing") this.jobs?.update(this.printJobView, "print", job.progress, job.layer[1] ? `Layer ${job.layer[0]} of ${job.layer[1]}` : undefined);
    });
    for (const ev of ["completed", "cancelled", "failed"] as const) {
      this.tracker.on(ev, (job) => {
        if (isFilamentJobFile(job.fileName)) {
          // A filament job ended. Short jobs can finish between polls, so "failed" here just
          // means the printer went READY without us seeing 100 %; only a cancel means it didn't run.
          if (ev !== "cancelled" && this.loadingFilament) this.setLoadedFilament(this.loadingFilament);
          ctx.log.write("info", `filament job ${ev}`, { file: job.fileName, filament: this.loadingFilament });
          this.loadingFilament = null;
          this.lastMessage = ev === "cancelled" ? "Filament change stopped" : "Filament change finished";
          this.emitStatus();
          return;
        }
        ctx.log.write("info", `print ${ev}`, { jobId: job.jobId, file: job.fileName });
        if (job.jobId) this.finishJob(job.jobId, ev);
        if (ev === "completed") {
          this.jobs?.done(this.printJobView, "print");
          this.jobs?.done(this.printJobView, "done");
        } else if (ev === "cancelled") this.jobs?.cancel(this.printJobView, "You ended the print");
        else this.jobs?.fail(this.printJobView, "print", new Error(`print ${ev}`), "MX-PRINT-001");
        this.printJobView = null;
        if (this.guardianRunning) void this.guardianCommand("stop", "auto");
      });
    }

    const python = process.env.MORPHIX_PYTHON || (existsSync(join(homedir(), ".local/share/morphix-vision/bin/python")) ? join(homedir(), ".local/share/morphix-vision/bin/python") : "python3");
    this.guardian = new PrintGuardian({
      storageRoot: ctx.storage.root,
      visionDir: join(o.repoRoot, "services", "vision"),
      worker: { pythonPath: python, snapshotUrl: `http://${o.printerHost}:8080/?action=snapshot`, intervalSeconds: 10 },
      alerts: {
        isPaused: (s) => s.online !== false && isPausedStatus(s, o.pausedStatuses),
        autoPause: false,
        pauseHook: o.controlsEnabled
          ? async (alert) => {
              const r = await this.controller.pause({ requestedBy: "guardian", reason: alert.kind });
              return { accepted: r.acknowledged, detail: r.error };
            }
          : undefined,
      },
      gemini: geminiVisionFromEnv(process.env),
      // Swarms: a multi-agent second opinion on each confirmed alert (local rules without a key).
      swarms: process.env.SWARMS_API_KEY?.trim() ? swarmsFromEnv(process.env) : undefined,
      // Tiger Data: guardian history into a TimescaleDB hypertable (TIGER_DATABASE_URL).
      telemetry: telemetryFromEnv(
        process.env,
        process.env.TIGER_DATABASE_URL?.trim() ? createTigerSink(process.env.TIGER_DATABASE_URL.trim(), { log: (m, x) => ctx.log.write("info", m, x) }) : undefined,
      ),
      store: this.store(),
      log: (l) => ctx.log.write("info", `[guardian] ${l}`),
    });
    this.guardian.onUpdate((snap) => ctx.event({ type: "guardian", snapshot: this.view(snap) }));
  }

  /** Called once the database is open. */
  init(): void {
    applyGuardianSchema({ exec: (sql) => this.ctx.db.exec(sql) });
  }

  private store(): GuardianStore {
    const db = () => this.ctx.db;
    return {
      sessionStarted: (s) => db().run("INSERT OR REPLACE INTO monitoring_sessions(id, print_job_id, started_at) VALUES (?,?,?)", [s.id, s.printJobId, s.startedAt]),
      sessionEnded: (s) => db().run("UPDATE monitoring_sessions SET ended_at = ? WHERE id = ?", [s.endedAt ?? now(), s.id]),
      alertChanged: (a, t) => {
        db().run(
          "INSERT OR REPLACE INTO failure_alerts(id, session_id, at, level, kind, confidence, snapshot_rel_path, detail) VALUES (?,?,?,?,?,?,?,?)",
          [a.id, a.sessionId, a.updatedAt, a.state, a.kind, a.score, this.rel(a.evidence[a.evidence.length - 1]), JSON.stringify({ state: a.state, verifications: a.verifications })],
        );
        if (t) db().run("INSERT INTO alert_transitions(alert_id, at, from_state, to_state, reason) VALUES (?,?,?,?,?)", [a.id, t.at, t.from, t.to, t.reason ?? null]);
      },
      evidenceSaved: (e) =>
        db().run("INSERT OR REPLACE INTO guardian_evidence(id, session_id, alert_id, at, label, kind, rel_path) VALUES (?,?,?,?,?,?,?)", [
          e.id, e.sessionId, e.alertId, e.at, e.label, e.kind, e.relPath,
        ]),
    };
  }

  private rel(abs: string | undefined): string | null {
    if (!abs) return null;
    const p = resolve(abs);
    return p.startsWith(this.ctx.storage.root + sep) ? relative(this.ctx.storage.root, p).split(sep).join("/") : null;
  }

  // -------------------------------------------------------------------------
  // Phase 3 — print preparation

  async prepare(versionId: string, settings: Partial<PrepareSettings> | "auto" = "auto", trackId: string | null = null, owner = "touchscreen", extra: { speedMmS?: number; zOffsetMm?: number } = {}): Promise<PrepareSummary> {
    const { db, storage } = this.ctx;
    const v = db.get("SELECT * FROM model_versions WHERE id = ?", [versionId]);
    if (!v) throw new Error("model not found");
    if (this.busy) throw new Error(`busy: ${this.busy}`);
    const auto = settings === "auto";
    const s: PrepareSettings = { ...DEFAULT_SETTINGS, ...(auto ? {} : settings) };
    // Slice for the filament in the printer unless the user picked another one.
    s.filament = !auto && isFilamentId(settings.filament) ? settings.filament : this.loadedFilament();
    // Speed from the Prepare page: one speed for every layer, up to the printer's maximum.
    const speed = Number(extra.speedMmS ?? (auto ? undefined : settings.speedMmS));
    if (speed > 0) s.speedMmS = clampSpeed(speed);
    else delete s.speedMmS;
    // Z offset from the Prepare page (nozzle height above the bed); unset = the profile's.
    const z = extra.zOffsetMm ?? (auto ? undefined : settings.zOffsetMm);
    if (typeof z === "number" && Number.isFinite(z)) s.zOffsetMm = clampZOffset(z);
    else delete s.zOffsetMm;
    const projectId = String(v.project_id);
    const project = db.get("SELECT title, prompt FROM projects WHERE id = ?", [projectId]);
    if (!trackId) trackId = this.jobs?.create("prepare", `Getting ${String(project?.title ?? "it")} ready`, owner, { projectId, versionId }).id ?? null;
    const jobId = randomUUID();
    const outDir = storage.path("prints", jobId);
    const t = now();
    db.run("INSERT INTO print_jobs(id, project_id, version_id, state, settings_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [
      jobId, projectId, versionId, "preparing", JSON.stringify(s), t, t,
    ]);
    walk(this.ctx, projectId, ["sizing", "validating"]);
    this.busy = "preparing print";
    const main = storage.path(String(v.rel_path));
    const isGlb = String(v.format) === "glb";
    const target = v.target_height_mm == null ? null : Number(v.target_height_mm);
    let summary: PrepareSummary;
    let lastKey: string | null = null;
    const onStage = (stage: string) => {
      this.ctx.event({ type: "prepare-progress", jobId, stage });
      if (stage === "slice") walk(this.ctx, projectId, ["slicing"]);
      const key = STAGE_KEY[stage];
      if (key && key !== lastKey) {
        if (lastKey) this.jobs?.done(trackId, lastKey);
        this.jobs?.start(trackId, key);
        lastKey = key;
      }
    };
    try {
      const options = {
        outputDir: outDir,
        baseName: "model",
        profilesDir: join(this.o.repoRoot, "config", "slicer-profiles"),
        filament: s.filament as FilamentId,
        ...(s.speedMmS ? { speedMmS: s.speedMmS } : {}),
        ...(s.zOffsetMm !== undefined ? { zOffsetMm: s.zOffsetMm } : {}),
        leveling: this.o.leveling,
        ...(isGlb ? {} : v.source === "meshy" ? { upAxis: "auto" as const } : { upAxis: "z" as const }),
        // Library designs are exported print-ready: keep the designer's orientation (and, with
        // no target height, their exact size — bearings and screws depend on it).
        ...(v.source === "library" ? { orientation: "keep" as const } : {}),
      };
      let r: PreparePrintResult;
      let advice: PrepareSummary["advice"];
      if (auto) {
        const a = await prepareWithAdvice({
          inputPath: main,
          targetHeightMm: target,
          description: String(project?.prompt ?? ""),
          intendedUse: "unknown",
          gemini: advisorGeminiFromEnv(process.env),
          options,
          onProgress: onStage,
        });
        r = a;
        s.layerHeightMm = a.advice.layerHeightMm;
        s.infillPercent = a.advice.infillPercent;
        s.supports = a.advice.supports;
        advice = {
          slicer: a.advice.slicer, layerHeightMm: a.advice.layerHeightMm, infillPercent: a.advice.infillPercent, supports: a.advice.supports,
          brim: a.advice.brim, reasons: a.advice.reasons, warnings: a.advice.warnings, source: a.advice.source,
        };
      } else {
        r = await preparePrint({ inputPath: main, targetHeightMm: target, options: { ...options, supports: s.supports, layerHeightMm: s.layerHeightMm, infillPercent: s.infillPercent, onProgress: onStage } });
      }
      const fileName = `morphix-${jobId.slice(0, 8)}.gx`;
      summary = {
        jobId, projectId, versionId, createdAt: t, settings: s, ok: r.ok && r.fits.fits,
        size: r.size, fits: r.fits.fits, upAxis: r.upAxis.axis,
        repairs: r.repair ? describeRepair(r.repair as unknown as Record<string, unknown>) : [],
        issues: r.report.final.issues ?? [],
        warnings: r.warnings,
        slicer: r.slicer.ok ? { ok: true, name: (r.slicer as { slicer?: { name?: string; version?: string } }).slicer?.name } : { ok: false, reason: r.slicer.reason, message: r.slicer.message },
        estimates: { printTimeS: r.estimates.printTimeS, filamentG: r.estimates.filamentG, filamentMm: r.estimates.filamentMm, layerCount: r.estimates.layerCount, source: r.estimates.source },
        gx: r.gx.ok ? { ok: true, verified: r.gx.verified || this.o.gxVerified, fileName, bytes: r.gx.buffer.length } : { ok: false, verified: false, reason: r.gx.message },
        previewUrl: null,
        advice,
        errorCode: !r.fits.fits ? "MX-SLICE-004" : !r.slicer.ok ? toMorphixError(new Error(r.slicer.message), "MX-SLICE-002").code : undefined,
      };
      if (lastKey) this.jobs?.done(trackId, lastKey);
      if (summary.ok) {
        this.jobs?.finishRemaining(trackId);
      } else {
        const failKey = !r.fits.fits ? "prepare.orient" : !r.slicer.ok ? "prepare.slice" : "prepare.gx";
        this.jobs?.fail(trackId, failKey, new Error(!r.fits.fits ? "model is too large for the build volume" : r.slicer.ok ? (r.gx.ok ? "not ready" : r.gx.message) : r.slicer.message), summary.errorCode ?? "MX-SLICE-001");
      }
      db.run("UPDATE print_jobs SET state = ?, file_rel_path = ?, summary_json = ?, updated_at = ? WHERE id = ?", [
        summary.ok ? "ready_for_approval" : "prepare_incomplete", r.files.gx ? storage.relative(r.files.gx) : null, JSON.stringify(summary), now(), jobId,
      ]);
      walk(this.ctx, projectId, summary.ok ? ["slicing", "approval"] : ["sizing"]);
      this.ctx.log.write("info", "print prepared", { jobId, ok: summary.ok, slicer: summary.slicer, fits: summary.fits, estimates: summary.estimates });
    } catch (e) {
      const me = this.jobs?.fail(trackId, lastKey ?? "prepare.check", e, "MX-SLICE-001") ?? toMorphixError(e, "MX-SLICE-001");
      summary = {
        jobId, projectId, versionId, createdAt: t, settings: s, ok: false, error: me.title ?? (e as Error).message, errorCode: me.code,
        repairs: [], issues: [], warnings: [], slicer: { ok: false, reason: "error", message: (e as Error).message }, gx: { ok: false, verified: false },
      };
      db.run("UPDATE print_jobs SET state = 'prepare_failed', summary_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(summary), now(), jobId]);
      walk(this.ctx, projectId, ["sizing"]);
      this.ctx.log.write("error", "print prepare failed", { jobId, error: (e as Error).message });
    } finally {
      this.busy = null;
      db.flush();
    }
    return summary;
  }

  latest(projectId: string): PrepareSummary | null {
    const r = this.ctx.db.get("SELECT summary_json FROM print_jobs WHERE project_id = ? AND summary_json IS NOT NULL ORDER BY created_at DESC LIMIT 1", [projectId]);
    return r ? (JSON.parse(String(r.summary_json)) as PrepareSummary) : null;
  }

  // -------------------------------------------------------------------------
  // Phase 5 — printing (two operator switches + explicit approval per print)

  status(): PrintControlStatus {
    const j = this.tracker.job;
    return {
      enabled: this.o.controlsEnabled,
      gxVerified: this.o.gxVerified,
      job: j.phase === "idle" ? null : { jobId: j.jobId, fileName: j.fileName, phase: j.phase, progress: j.progress, layer: j.layer, recovered: j.recovered, offline: j.offline, ...this.timing(j) },
      busy: this.busy,
      lastMessage: this.lastMessage,
    };
  }

  private estimates = new Map<string, number | null>();

  /** The slicer's whole-print estimate for a job (looked up by job id, else by printer file name). */
  private estimateFor(jobId: string | undefined, fileName: string | undefined): number | null {
    const key = jobId ?? fileName ?? "";
    if (!key) return null;
    if (this.estimates.has(key)) return this.estimates.get(key)!;
    let est: number | null = null;
    try {
      const rows = jobId
        ? [this.ctx.db.get("SELECT summary_json FROM print_jobs WHERE id = ?", [jobId])]
        : this.ctx.db.all("SELECT summary_json FROM print_jobs WHERE summary_json LIKE ? ORDER BY created_at DESC LIMIT 1", [`%${fileName}%`]);
      const s = rows[0]?.summary_json ? (JSON.parse(String(rows[0].summary_json)) as PrepareSummary) : null;
      est = s?.estimates?.printTimeS ?? null;
    } catch {
      est = null;
    }
    this.estimates.set(key, est);
    return est;
  }

  /** Elapsed / remaining / estimate for the Printer page. */
  private timing(j: { jobId?: string; fileName?: string; progress: number; startedAt?: string; recovered: boolean; phase: string }) {
    const estimateS = isFilamentJobFile(j.fileName) ? 150 : this.estimateFor(j.jobId, j.fileName);
    const elapsedS = j.startedAt && !j.recovered ? Math.max(0, Math.round((Date.now() - Date.parse(j.startedAt)) / 1000)) : null;
    return { elapsedS, estimateS, remainingS: remainingSeconds(j.progress, elapsedS, estimateS) };
  }


  /**
   * M23 right after an upload. The QD330 takes one connection at a time and sometimes drops
   * the next one while it finishes saving the file ("printer closed the connection" before
   * anything was sent). Retry only while nothing reached the printer: the approval is consumed
   * only when M23 is sent, so a print can never be started twice.
   */
  private async startAfterUpload(opts: Parameters<QD330Controller["startPrint"]>[0], waitsMs = [1_500, 3_000, 5_000]) {
    let r = await this.controller.startPrint(opts);
    for (const ms of waitsMs) {
      if (r.confirmed || r.sent) break;
      this.ctx.log.write("info", "print start retry", { fileName: opts.fileName, waitMs: ms, error: r.error });
      await new Promise((ok) => setTimeout(ok, ms));
      r = await this.controller.startPrint(opts);
    }
    return r;
  }

  private emitStatus(): void {
    this.ctx.event({ type: "print-status", status: this.status() });
  }

  // -------------------------------------------------------------------------
  // Filament

  /** What the user says is in the printer (the printer can't report it). */
  loadedFilament(): FilamentId {
    const v = this.ctx.db?.getSetting<string>("loadedFilament", DEFAULT_FILAMENT);
    return isFilamentId(v) ? v : DEFAULT_FILAMENT;
  }

  setLoadedFilament(id: string): FilamentState {
    if (!isFilamentId(id)) throw new Error(`unknown filament ${id}`);
    this.ctx.db.setSetting("loadedFilament", id);
    this.ctx.db.flush();
    this.ctx.log.write("info", "loaded filament set", { filament: id });
    return this.filaments();
  }

  /** "Normal" values for the Prepare page, read from the printer profile. */
  slicerDefaults(): SlicerDefaults {
    let z = 0;
    try {
      z = profileZOffset(readFileSync(join(this.o.repoRoot, "config", "slicer-profiles", "qd330-pla-0.2mm.ini"), "utf8")) ?? 0;
    } catch {
      /* profile missing: 0 */
    }
    return { zOffsetMm: z, minZOffsetMm: MIN_Z_OFFSET_MM, maxZOffsetMm: MAX_Z_OFFSET_MM };
  }

  filaments(): FilamentState {
    return {
      loaded: this.loadedFilament(),
      list: FILAMENT_IDS.map((id) => {
        const f = FILAMENTS[id];
        return { id, label: f.label, blurb: f.blurb, nozzleC: f.nozzleC, bedC: f.bedC, changeC: f.changeC, maxVolumetricMm3S: f.maxVolumetricMm3S, notes: f.notes };
      }),
    };
  }

  /**
   * Load or unload filament by running a tiny print job (heat, then feed or pull). The
   * printer ignores extruder moves sent directly, but runs them from a file. The tap on the
   * Control tab (with its confirm) is the approval.
   */
  async filamentJob(kind: FilamentChange, to?: string): Promise<{ ok: boolean; message: string }> {
    if (!this.o.controlsEnabled) return { ok: false, message: "Printer control is locked — use the printer's own Filament menu." };
    if (this.busy) return { ok: false, message: `Busy: ${this.busy}` };
    if (this.tracker.active) return { ok: false, message: "The printer is printing — finish or end the print first." };
    if (kind === "load" && !isFilamentId(to)) return { ok: false, message: "Pick which filament you're loading." };
    const loaded = this.loadedFilament();
    const target = kind === "load" ? (to as FilamentId) : loaded;
    const tempC = kind === "load" ? changeTemperature(loaded, target) : filamentProfile(loaded).changeC;
    const gcode = filamentChangeGcode(kind, tempC, filamentProfile(target).label);
    const data = writeGx({
      // Header values like a real print (zeros here are one thing the firmware may refuse).
      gcode, thumbnailBmp: gxThumbnailBmp(null), printTimeS: 150, filamentMm: kind === "load" ? 100 : 10,
      layerHeightMm: 0.2, bedTempC: filamentProfile(target).bedC, extruderTempC: tempC,
    });
    const fileName = filamentJobFileName(kind);
    const jobId = `filament-${kind}-${Date.now()}`;
    const auth = this.authorizer.authorize({ jobId, fileName, approvedBy: "touch", expiresInMs: 120_000 });
    this.busy = kind === "load" ? "starting filament load" : "starting filament unload";
    this.emitStatus();
    try {
      const up = await this.controller.uploadFile(fileName, data, { jobId, authorization: auth, overwrite: true });
      if (!up.confirmed) throw new Error(`upload not confirmed: ${up.error ?? up.reply ?? "no reply"}`);
      const start = await this.startAfterUpload({ jobId, fileName, authorization: auth, expectedBytes: data.length });
      if (!start.confirmed) throw new Error(`start not confirmed: ${start.error ?? "printer did not report it"}`);
      this.loadingFilament = kind === "load" ? target : null;
      this.tracker.track({ jobId, fileName, status: start.status });
      this.ctx.log.write("info", "filament job started", { kind, filament: target, tempC });
      this.lastMessage = kind === "load" ? `Loading ${filamentProfile(target).label}: heating to ${tempC} °C, then feeding` : `Unloading: heating to ${tempC} °C, then pulling the filament out`;
      return { ok: true, message: this.lastMessage };
    } catch (e) {
      this.lastMessage = `Filament ${kind} didn't start: ${(e as Error).message}`;
      return { ok: false, message: this.lastMessage };
    } finally {
      this.busy = null;
      this.emitStatus();
    }
  }

  /** Checks a print may be proposed; returns the details for the confirmation screen. */
  printProposal(jobId: string): Omit<PendingAction, "id" | "createdAt"> {
    if (!this.o.controlsEnabled) {
      throw new Error("Printer control is locked. It is switched on only after the operator validation checklist (MORPHIX_PRINT_CONTROLS=1).");
    }
    const r = this.ctx.db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
    if (!r?.summary_json || !r.file_rel_path) throw new Error("prepare the model for printing first");
    const s = JSON.parse(String(r.summary_json)) as PrepareSummary;
    if (!s.ok || !s.gx.ok || !s.gx.fileName) throw new Error("this print job isn't ready (see the preparation report)");
    if (!s.gx.verified && !this.o.gxVerified) {
      throw new Error("Morphix's .gx output hasn't been verified against the official Afinia slicer yet (MORPHIX_GX_VERIFIED=1 after checking).");
    }
    if (this.tracker.active) throw new Error("the printer is already printing");
    const project = this.ctx.db.get("SELECT title FROM projects WHERE id = ?", [r.project_id]);
    const est = s.estimates;
    return {
      kind: "print", title: String(project?.title ?? "model"), prompt: `Send ${s.gx.fileName} to the QD330 and start printing.`,
      projectId: String(r.project_id), versionId: String(r.version_id), credits: 0, jobId, fileName: s.gx.fileName,
      details: [
        s.size ? `${s.size.x.toFixed(0)} × ${s.size.y.toFixed(0)} × ${s.size.z.toFixed(0)} mm` : "",
        est?.printTimeS ? `about ${formatDuration(est.printTimeS)}` : "",
        est?.filamentG ? `${est.filamentG.toFixed(0)} g of ${filamentProfile(s.settings.filament).label}` : "",
        s.settings.filament && s.settings.filament !== this.loadedFilament()
          ? `⚠️ Sliced for ${filamentProfile(s.settings.filament).label} but ${filamentProfile(this.loadedFilament()).label} is loaded — change the filament first.`
          : "",
        ...filamentProfile(s.settings.filament).notes,
        `Check the bed is clear and ${filamentProfile(s.settings.filament).label} is loaded.`,
      ].filter(Boolean),
    };
  }

  /** Runs only from a confirmed pending action (touch tap or verified spoken yes). */
  async startApprovedPrint(jobId: string, approvedBy: ApprovalSource): Promise<void> {
    const proposal = this.printProposal(jobId); // re-check every precondition
    const fileName = proposal.fileName!;
    const r = this.ctx.db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId])!;
    const data = this.ctx.storage.read(this.ctx.storage.path(String(r.file_rel_path)));
    const auth = this.authorizer.authorize({ jobId, fileName, approvedBy, expiresInMs: 180_000 });
    const projectId = String(r.project_id);
    this.busy = "sending file to printer";
    this.emitStatus();
    const project = this.ctx.db.get("SELECT title FROM projects WHERE id = ?", [projectId]);
    this.printJobView = this.jobs?.create("print", `Printing ${String(project?.title ?? fileName)}`, approvedBy, { jobId, fileName }, { approval: false }).id ?? null;
    this.jobs?.start(this.printJobView, "send", fileName);
    try {
      this.ctx.db.run("UPDATE print_jobs SET state = 'uploading', approved_at = ?, updated_at = ? WHERE id = ?", [now(), now(), jobId]);
      walk(this.ctx, projectId, ["uploading"], { printControlsEnabled: true, userApproved: true });
      const up = await this.controller.uploadFile(fileName, data, {
        jobId,
        authorization: auth,
        overwrite: true, // a retry of the same job re-sends its file
        onProgress: (p) => this.jobs?.update(this.printJobView, "send", p.percent, `${Math.round(p.bytesSent / 1e5) / 10} of ${Math.round(p.totalBytes / 1e5) / 10} MB`),
      });
      if (!up.confirmed) throw new Error(`upload not confirmed: ${up.error ?? up.reply ?? "no reply"}`);
      walk(this.ctx, projectId, ["ready"], { printControlsEnabled: true, userApproved: true });
      this.jobs?.done(this.printJobView, "send");
      this.busy = "starting print";
      this.emitStatus();
      const start = await this.startAfterUpload({ jobId, fileName, authorization: auth, expectedBytes: data.length });
      if (!start.confirmed) throw new Error(`print start not confirmed: ${start.error ?? "printer did not report printing"}`);
      this.tracker.track({ jobId, fileName, status: start.status });
      this.activeJobId = jobId;
      walk(this.ctx, projectId, ["printing"], { printControlsEnabled: true, userApproved: true });
      this.ctx.db.run("UPDATE print_jobs SET state = 'printing', updated_at = ? WHERE id = ?", [now(), jobId]);
      this.lastMessage = `Printing ${fileName}`;
      this.jobs?.start(this.printJobView, "print", "Heating up and starting");
      this.guardianStoppedByUser = false; // a new print
      if (!this.guardianRunning) void this.guardianCommand("start", "auto");
    } catch (e) {
      this.lastMessage = (e as Error).message;
      const stage = this.jobs?.manager.get(this.printJobView ?? "")?.stages.find((x) => x.status === "running")?.key ?? "send";
      this.jobs?.fail(this.printJobView, stage, e, "MX-PRINT-001");
      this.printJobView = null;
      this.ctx.db.run("UPDATE print_jobs SET state = 'failed', updated_at = ? WHERE id = ?", [now(), jobId]);
      walk(this.ctx, projectId, ["failed"], { printControlsEnabled: true });
      throw e;
    } finally {
      this.busy = null;
      this.ctx.db.flush();
      this.emitStatus();
    }
  }

  private finishJob(jobId: string, outcome: "completed" | "cancelled" | "failed"): void {
    const r = this.ctx.db.get("SELECT project_id FROM print_jobs WHERE id = ?", [jobId]);
    this.ctx.db.run("UPDATE print_jobs SET state = ?, updated_at = ? WHERE id = ?", [outcome, now(), jobId]);
    if (r) walk(this.ctx, String(r.project_id), [outcome === "completed" ? "completed" : "failed"], { printControlsEnabled: true });
    this.activeJobId = null;
    this.emitStatus();
  }

  async pause(): Promise<{ ok: boolean; message: string }> {
    if (!this.o.controlsEnabled) return { ok: false, message: "Printer control is locked — press pause on the printer itself." };
    const r = await this.controller.pause({ requestedBy: "touch", reason: "operator" });
    this.lastMessage = r.confirmed ? "Printer confirmed paused" : `Pause not confirmed${r.error ? `: ${r.error}` : ""} — use the printer's screen if it keeps printing.`;
    this.emitStatus();
    return { ok: r.confirmed, message: this.lastMessage };
  }

  /** M24 for the paused job. The tap on Resume is the fresh approval the controller requires. */
  async resume(approvedBy: ApprovalSource = "touch"): Promise<{ ok: boolean; message: string }> {
    if (!this.o.controlsEnabled) return { ok: false, message: "Printer control is locked — resume on the printer itself." };
    const job = this.tracker.job;
    if (job.phase !== "paused" || !job.fileName) return { ok: false, message: "There is no paused print to resume." };
    const jobId = job.jobId ?? `resume-${Date.now()}`;
    const authorization = this.authorizer.authorize({ jobId, fileName: job.fileName, approvedBy, expiresInMs: 60_000 });
    const r = await this.controller.resume({ jobId, fileName: job.fileName, authorization });
    this.lastMessage = r.confirmed ? "Printer confirmed the print is running again" : `Resume not confirmed${r.error ? `: ${r.error}` : ""} — use the printer's screen.`;
    this.emitStatus();
    return { ok: r.confirmed, message: this.lastMessage };
  }

  async cancel(): Promise<{ ok: boolean; message: string }> {
    if (!this.o.controlsEnabled) return { ok: false, message: "Printer control is locked — cancel on the printer itself." };
    this.tracker.noteCancelRequested();
    const r = await this.controller.cancel({ requestedBy: "touch", reason: "operator" });
    this.lastMessage = r.confirmed ? "Printer confirmed the print was cancelled" : `Cancel not confirmed${r.error ? `: ${r.error}` : ""} — use the printer's screen.`;
    this.emitStatus();
    return { ok: r.confirmed, message: this.lastMessage };
  }

  // -------------------------------------------------------------------------
  // Machine controls: light, fan, home, temperatures, motors, stop

  capabilities(): MachineCapability[] {
    try {
      return this.controller.capabilities().map((c) => ({
        command: String(c.command),
        verified: c.protocolVerified,
        enabled: c.enabled,
        allowedNow: c.allowedNow,
        reason: c.reason,
      }));
    } catch {
      return [];
    }
  }

  async machine(c: MachineCommand, by: MachineApprovalSource): Promise<{ ok: boolean; message: string; code?: string }> {
    const requestedBy: RequestedBy = by === "portal" ? "system" : by;
    const reason = `${by} request`;
    try {
      let r: { confirmed: boolean; acknowledged: boolean; error?: string; protocolVerified?: boolean };
      let what: string;
      switch (c.cmd) {
        case "light":
          r = await this.controller.setLight(c.on, { requestedBy, reason });
          what = c.on ? "Light on" : "Light off";
          break;
        case "fan":
          r = await this.controller.setFan(Math.max(0, Math.min(100, Math.round(c.percent))), { requestedBy, reason });
          what = c.percent > 0 ? `Fan at ${Math.round(c.percent)}%` : "Fan off";
          break;
        case "home":
          r = await this.controller.home({ requestedBy, reason });
          what = "Printer homed";
          break;
        case "nozzle":
          r = await this.controller.setNozzleTemp(c.celsius, { requestedBy, approvedBy: by, reason });
          what = `Nozzle set to ${c.celsius} °C`;
          break;
        case "bed":
          r = await this.controller.setBedTemp(c.celsius, { requestedBy, approvedBy: by, reason });
          what = `Bed set to ${c.celsius} °C`;
          break;
        case "cooldown":
          r = await this.controller.coolDown({ requestedBy, reason });
          what = "Cooling down";
          break;
        case "motorsOff":
          r = await this.controller.motorsOff({ requestedBy, reason });
          what = "Motors off";
          break;
        case "stop":
          this.tracker.noteCancelRequested();
          r = await this.controller.emergencyStop({ requestedBy, reason });
          what = "Stopped";
          break;
      }
      this.ctx.log.write("info", `machine ${c.cmd}`, { by, confirmed: r.confirmed, acknowledged: r.acknowledged, error: r.error });
      if (r.confirmed) return { ok: true, message: `${what} ✅` };
      if (r.acknowledged) return { ok: true, message: `${what} (the printer accepted it but didn't confirm)` };
      const me = toMorphixError(new Error(r.error ?? "printer did not respond"), "MX-PRINT-002");
      return { ok: false, message: me.title, code: me.code };
    } catch (e) {
      const me = toMorphixError(e, "MX-PRINT-004");
      return { ok: false, message: `${me.title}: ${(e as Error).message}`, code: me.code };
    }
  }

  /** Every observer poll: job tracking, guardian stall/pause confirmation, auto-start monitoring. */
  onPrinterStatus(s: PrinterStatus): void {
    this.tracker.update(s);
    this.guardian.updatePrinterStatus(s); // offline polls too: the guardian stops trusting a stale "printing"
    if (s.online) {
      const active = detectActivePrint(s, this.o.pausedStatuses);
      if (!active) this.guardianStoppedByUser = false; // that print is over
      const filamentJob = isFilamentJobFile(active?.fileName ?? this.tracker.job.fileName);
      if (active && !filamentJob && !this.guardianRunning && !this.guardianStoppedByUser) void this.guardianCommand("start", "auto");
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4 — guardian

  view(snap: GuardianSnapshot = this.guardian.snapshot()): GuardianView {
    const a = snap.alert;
    const verification = a?.verifications?.[a.verifications.length - 1] as { explanation?: string; summary?: string } | undefined;
    return {
      running: this.guardianRunning,
      state: snap.state,
      label: snap.label,
      camera: snap.camera,
      cameraDetail: snap.cameraDetail,
      worker: typeof snap.worker === "string" ? snap.worker : JSON.stringify(snap.worker),
      alert: a
        ? {
            id: a.id, kind: a.kind, state: a.state, score: a.score, openedAt: a.openedAt,
            evidenceUrls: a.evidence.map((p) => this.ctx.url(this.rel(p))).filter((u): u is string => Boolean(u)).slice(-3),
            explanation: verification?.explanation ?? verification?.summary,
          }
        : null,
      gemini: snap.gemini.available,
      autoPause: snap.autoPause,
      pauseAvailable: this.o.controlsEnabled,
      voice: this.voiceInfo?.() ?? null,
    };
  }

  async guardianCommand(cmd: "start" | "stop" | "requestPause" | "resolve" | "dismiss" | "resetBaseline", by: "operator" | "auto" = "operator"): Promise<GuardianView> {
    switch (cmd) {
      case "start":
        if (by === "operator") this.guardianStoppedByUser = false;
        if (!this.guardianRunning) {
          this.guardian.start({ printJobId: this.activeJobId ?? undefined });
          this.guardianRunning = true;
        }
        break;
      case "stop":
        if (by === "operator") this.guardianStoppedByUser = true;
        if (this.guardianRunning) {
          this.guardianRunning = false;
          await this.guardian.stop(by === "operator" ? "stopped by operator" : "print ended");
        }
        break;
      case "requestPause":
        await this.guardian.requestPause();
        break;
      case "resolve":
        this.guardian.resolve("operator");
        break;
      case "dismiss":
        this.guardian.dismiss("operator: false alarm");
        break;
      case "resetBaseline":
        this.guardian.resetBaseline();
        break;
    }
    const v = this.view();
    this.ctx.event({ type: "guardian", snapshot: v });
    return v;
  }

  async shutdown(): Promise<void> {
    if (this.guardianRunning) await this.guardian.stop("app quit");
  }
}

function describeRepair(r: Record<string, unknown>): string[] {
  return Object.entries(r)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${v}`);
}

export function formatDuration(s: number): string {
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
