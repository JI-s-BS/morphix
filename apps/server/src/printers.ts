// Which printer Morphix talks to. A printer configured on the setup page (MorphixConfig.printers +
// activePrinterId) connects through its PrinterDriver; with none configured, the original
// Afinia QD330 path (apps/desktop/electron/printing.ts) stays in charge.
import type { ConfigStore, ConfiguredPrinter, MorphixConfig } from "@morphix/config";
import { findPrinter } from "@morphix/catalog";
import { DriverError, getDriver, type DriverConfig, type DriverDeps, type DriverStatus, type PrinterConnection, type PrinterDriver } from "@morphix/printer";
import type { MachineCapability, MachineCommand, PrintControlStatus, PrinterInfo, PrinterStatus } from "@morphix/shared";

export type ActivePrinter =
  | { kind: "qd330"; reason: string }
  | { kind: "driver"; printer: ConfiguredPrinter; driver: PrinterDriver; connection: PrinterConnection };

/** Picks the active configured printer and connects its driver (no network traffic yet). */
export async function resolveActivePrinter(
  config: MorphixConfig | null,
  store: Pick<ConfigStore, "getSecret"> | null,
  opts: { lookup?: (id: string) => PrinterDriver | undefined; deps?: DriverDeps } = {},
): Promise<ActivePrinter> {
  const printers = config?.printers ?? [];
  if (!printers.length) return { kind: "qd330", reason: "no printer configured" };
  const printer = printers.find((p) => p.id === config?.activePrinterId) ?? (printers.length === 1 ? printers[0] : undefined);
  if (!printer) return { kind: "qd330", reason: "no active printer chosen" };
  const driver = (opts.lookup ?? getDriver)(printer.driver);
  if (!driver) return { kind: "qd330", reason: `driver ${printer.driver} is not available in this build` };
  const values: DriverConfig = { ...printer.connection };
  for (const f of driver.fields) {
    if (f.kind !== "secret") continue;
    const v = store ? await store.getSecret(`printer:${printer.id}:${f.key}`) : undefined;
    if (v !== undefined) values[f.key] = v;
  }
  return { kind: "driver", printer, driver, connection: driver.connect(values, opts.deps) };
}

// ------------------------------------------------------------ status map ---

/** Driver status in the shape the UI already shows (PrinterStatus). */
export function toPrinterStatus(s: DriverStatus): PrinterStatus {
  const out: PrinterStatus = {
    online: s.state !== "offline",
    checkedAt: s.checkedAt,
    machine: s.state.toUpperCase(),
  };
  if (s.state === "offline" || s.state === "error") out.error = s.message ?? (s.state === "offline" ? "printer offline" : "printer error");
  if (s.job?.file) out.currentFile = s.job.file;
  if (typeof s.job?.progress === "number") out.progress = Math.round(s.job.progress * 100);
  if (s.job?.layer) out.layer = s.job.layer;
  const t = s.temps;
  if (t?.nozzle || t?.bed) {
    out.temps = {};
    if (t.nozzle) out.temps.nozzle = { current: t.nozzle.actual, target: t.nozzle.target ?? 0 };
    if (t.bed) out.temps.bed = { current: t.bed.actual, target: t.bed.target ?? 0 };
  }
  return out;
}

/** Polls a driver connection; same surface as PrinterObserver (status, info, start, stop). */
export class DriverObserver {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: PrinterStatus = { online: false, checkedAt: new Date(0).toISOString(), error: "not checked yet" };
  private raw: DriverStatus | null = null;

  constructor(
    private conn: PrinterConnection,
    private onStatus: (s: PrinterStatus, previous: PrinterStatus) => void,
  ) {}

  get status(): PrinterStatus {
    return this.last;
  }

  get driverStatus(): DriverStatus | null {
    return this.raw;
  }

  async poll(): Promise<PrinterStatus> {
    const previous = this.last;
    try {
      this.raw = await this.conn.status();
      this.last = toPrinterStatus(this.raw);
    } catch (e) {
      this.raw = null;
      this.last = { online: false, checkedAt: new Date().toISOString(), error: (e as Error).message };
    }
    this.onStatus(this.last, previous);
    return this.last;
  }

  async info(): Promise<PrinterInfo> {
    const r = await this.conn.test();
    if (!r.ok) throw new Error(r.hint ? `${r.message} ${r.hint}` : r.message);
    return { machineType: r.info.model, machineName: r.info.name, firmware: r.info.firmware, serial: r.info.serial };
  }

  start(intervalMs: number): void {
    this.stop();
    this.running = true;
    const tick = async () => {
      await this.poll();
      if (this.running) this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// --------------------------------------------------------------- control ---

const msg = (e: unknown) => (e instanceof DriverError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : (e as Error).message);

/**
 * Print / machine controls for a driver printer. Every command checks the last status first:
 * pause only while printing, resume only while paused, cancel only with a job, temperatures only
 * within the catalog model's limits. Nothing here starts a print.
 */
export class DriverControl {
  private lastMessage: string | null = null;

  constructor(
    private conn: PrinterConnection,
    private printer: ConfiguredPrinter,
    private observer: DriverObserver,
  ) {}

  private async fresh(): Promise<DriverStatus | null> {
    await this.observer.poll();
    return this.observer.driverStatus;
  }

  private async run(what: string, ok: string, fn: () => Promise<void>): Promise<{ ok: boolean; message: string }> {
    try {
      await fn();
      this.lastMessage = ok;
      void this.observer.poll();
      return { ok: true, message: ok };
    } catch (e) {
      this.lastMessage = `${what} didn't work: ${msg(e)}`;
      return { ok: false, message: this.lastMessage };
    }
  }

  async pause(): Promise<{ ok: boolean; message: string }> {
    const s = await this.fresh();
    if (!this.conn.capabilities().pause) return { ok: false, message: "This printer can't be paused from Morphix. Use the printer's screen." };
    if (s?.state !== "printing") return { ok: false, message: "The printer isn't printing, so there is nothing to pause." };
    return this.run("Pause", "Pause sent to the printer", () => this.conn.pause());
  }

  async resume(): Promise<{ ok: boolean; message: string }> {
    const s = await this.fresh();
    if (!this.conn.capabilities().resume) return { ok: false, message: "This printer can't be resumed from Morphix. Use the printer's screen." };
    if (s?.state !== "paused") return { ok: false, message: "There is no paused print to resume." };
    return this.run("Resume", "Resume sent to the printer", () => this.conn.resume());
  }

  async cancel(): Promise<{ ok: boolean; message: string }> {
    const s = await this.fresh();
    if (!this.conn.capabilities().cancel) return { ok: false, message: "This printer can't be cancelled from Morphix. Use the printer's screen." };
    if (!s || !["printing", "paused", "heating", "finishing"].includes(s.state)) return { ok: false, message: "There is no print to cancel." };
    return this.run("Cancel", "Cancel sent to the printer", () => this.conn.cancel());
  }

  status(): PrintControlStatus {
    const s = this.observer.driverStatus;
    const job = s?.job && s.state !== "idle" && s.state !== "offline"
      ? {
          fileName: s.job.file,
          phase: s.state,
          progress: Math.round((s.job.progress ?? 0) * 100),
          layer: s.job.layer ?? ([0, 0] as [number, number]),
          recovered: true,
          offline: false,
          elapsedS: s.job.elapsedS ?? null,
          remainingS: s.job.remainingS ?? null,
          estimateS: null,
        }
      : null;
    return { enabled: true, gxVerified: false, job, busy: null, lastMessage: this.lastMessage };
  }

  limits(): { nozzle: number; bed: number } | null {
    const m = findPrinter(this.printer.modelId);
    return m ? { nozzle: m.maxNozzleC, bed: m.heatedBed ? m.maxBedC : 0 } : null;
  }

  capabilities(): MachineCapability[] {
    const caps = this.conn.capabilities();
    const temps = !!caps.setTemperature && !!this.conn.setTemperature && this.limits() !== null;
    const s = this.observer.driverStatus;
    const online = !!s && s.state !== "offline";
    const tempReason = !temps ? "not supported for this printer" : !online ? "printer offline" : undefined;
    return [
      { command: "nozzle", verified: false, enabled: temps, allowedNow: temps && online, reason: tempReason },
      { command: "bed", verified: false, enabled: temps, allowedNow: temps && online, reason: tempReason },
      { command: "cooldown", verified: false, enabled: temps, allowedNow: temps && online, reason: tempReason },
    ];
  }

  async machine(c: MachineCommand): Promise<{ ok: boolean; message: string; code?: string }> {
    const lim = this.limits();
    const set = this.conn.setTemperature?.bind(this.conn);
    if (!set || !this.conn.capabilities().setTemperature || !lim) return { ok: false, message: "This control isn't available for this printer yet. Use the printer's screen." };
    const s = await this.fresh();
    if (!s || s.state === "offline") return { ok: false, message: "The printer is offline." };
    // docs/SAFETY.md rule 1: no temperature changes during a print (cool-down after cancelling is from idle).
    if (["printing", "paused", "heating", "finishing", "busy"].includes(s.state)) return { ok: false, message: `The printer is ${s.state}. Temperatures can't be changed during a print.` };
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
    switch (c.cmd) {
      case "nozzle":
        return this.run("Nozzle temperature", `Nozzle set to ${clamp(c.celsius, lim.nozzle)} °C`, () => set("nozzle", clamp(c.celsius, lim.nozzle)));
      case "bed":
        if (!lim.bed) return { ok: false, message: "This printer has no heated bed." };
        return this.run("Bed temperature", `Bed set to ${clamp(c.celsius, lim.bed)} °C`, () => set("bed", clamp(c.celsius, lim.bed)));
      case "cooldown":
        return this.run("Cool down", "Heaters off", async () => {
          await set("nozzle", 0);
          if (lim.bed) await set("bed", 0);
        });
      default:
        return { ok: false, message: "This control isn't available for this printer yet. Use the printer's screen." };
    }
  }
}
