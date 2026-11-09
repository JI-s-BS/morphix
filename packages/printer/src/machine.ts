// Machine controls for the QD330 beyond job control: light, fan, temperatures,
// homing, motors, emergency stop. Pure helpers only (command builders, limits,
// the command table behind QD330Controller.capabilities()); the controller in
// control.ts does the I/O.
//
// Verified on the real printer (firmware v2.1.3): G28 (X/Y -> 110, Z -> 220),
// M26, M115/M119/M105/M114. Everything else here is UNVERIFIED and stays off
// until the operator enables it per command (`allowUnverified`) after the
// checklist in docs/PHASE5.md.
import type { PrinterStatus } from "@morphix/shared";

/** Who explicitly approved turning a heater on. */
export type MachineApprovalSource = "touch" | "voice" | "portal";
export const MACHINE_APPROVAL_SOURCES: readonly MachineApprovalSource[] = ["touch", "voice", "portal"];

/** Per-command switches for commands not yet verified on this printer. All default false. */
export interface UnverifiedCommandFlags {
  /** setLight (M146). */
  light?: boolean;
  /** setFan (M106/M107). */
  fan?: boolean;
  /** setNozzleTemp, setBedTemp, coolDown (M104/M140). */
  temperatures?: boolean;
  /** motorsOff (M18). */
  motors?: boolean;
  /** emergencyStop also sends M112 first. M112 may halt the firmware until a power cycle. */
  emergencyStopM112?: boolean;
}
export type UnverifiedFlag = keyof UnverifiedCommandFlags;

/** Hard limits. Options may lower them, never raise them. */
export const NOZZLE_MAX_C = 250;
export const BED_MAX_C = 100;
export const DEFAULT_HEATER_IDLE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MIN_COMMAND_INTERVAL_MS = 1000;
/** Window after a cancel in which heaters may be turned off even if the status still shows a print. */
export const DEFAULT_CANCEL_COOLDOWN_WINDOW_MS = 120_000;
/** Where G28 leaves the head (verified on the real QD330). */
export const DEFAULT_HOME_POSITION = { x: 110, y: 110, z: 220 } as const;
export const HOME_TOLERANCE_MM = 0.5;
export const TARGET_TOLERANCE_C = 0.5;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}
/** true = white, false = off, or a colour (each channel 0-255). */
export type LightSetting = boolean | RgbColor;
/** true = 100 %, false = off, or a speed in percent (0-100). */
export type FanSetting = boolean | number;

export class ControlLimitError extends RangeError {}

function channel(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) throw new ControlLimitError(`light ${name} must be an integer 0-255, got ${String(v)}`);
  return v;
}

export function normalizeLight(setting: LightSetting): RgbColor {
  if (setting === true) return { r: 255, g: 255, b: 255 };
  if (setting === false) return { r: 0, g: 0, b: 0 };
  if (!setting || typeof setting !== "object") throw new ControlLimitError("light must be true, false or { r, g, b }");
  return { r: channel(setting.r, "r"), g: channel(setting.g, "g"), b: channel(setting.b, "b") };
}

/** UNVERIFIED: FlashForge Adventurer syntax. */
export function lightCommand(c: RgbColor): string {
  return `M146 r${c.r} g${c.g} b${c.b} F0`;
}

export function normalizeFan(setting: FanSetting): number {
  if (setting === true) return 100;
  if (setting === false) return 0;
  if (typeof setting !== "number" || !Number.isFinite(setting) || setting < 0 || setting > 100) {
    throw new ControlLimitError(`fan speed must be 0-100 %, got ${String(setting)}`);
  }
  return Math.round(setting);
}

/** UNVERIFIED: M106 S0-255 / M107. */
export function fanCommand(percent: number): string {
  return percent === 0 ? "M107" : `M106 S${Math.round((percent * 255) / 100)}`;
}

export function normalizeTemp(celsius: unknown, max: number, what: string): number {
  if (typeof celsius !== "number" || !Number.isFinite(celsius)) throw new ControlLimitError(`${what} temperature must be a number, got ${String(celsius)}`);
  const c = Math.round(celsius);
  if (c < 0 || c > max) throw new ControlLimitError(`${what} temperature ${celsius} °C is outside 0-${max} °C`);
  return c;
}

/** UNVERIFIED on the QD330. */
export const nozzleCommand = (c: number) => `M104 S${c} T0`;
export const bedCommand = (c: number) => `M140 S${c}`;

/** "LED: 1" in an M119 reply -> true. undefined if the printer does not report it. */
export function parseLed(m119: string): boolean | undefined {
  const m = /^\s*LED:\s*(\d+)/m.exec(m119);
  return m ? Number(m[1]) !== 0 : undefined;
}

export function atPosition(st: PrinterStatus, p: { x: number; y: number; z: number }, tol = HOME_TOLERANCE_MM): boolean {
  const pos = st.position ?? {};
  return (["x", "y", "z"] as const).every((k) => typeof pos[k] === "number" && Math.abs(pos[k] - p[k]) <= tol);
}

export function targetIs(st: PrinterStatus, heater: "nozzle" | "bed", c: number): boolean {
  const t = st.temps?.[heater]?.target;
  return typeof t === "number" && Math.abs(t - c) <= TARGET_TOLERANCE_C;
}

// ---- command table -----------------------------------------------------------

export type ControllerCommand =
  | "readStatus"
  | "readInfo"
  | "listFiles"
  | "uploadFile"
  | "startPrint"
  | "pause"
  | "resume"
  | "cancel"
  | "home"
  | "setLight"
  | "setFan"
  | "setNozzleTemp"
  | "setBedTemp"
  | "coolDown"
  | "motorsOff"
  | "emergencyStop";

/** What the printer must be doing for a command to be sent. */
export type StateRule =
  | "any" // always sent (read-only, cancel, emergency stop, light, fan)
  | "ready" // MachineStatus READY
  | "idle" // READY and not moving
  | "printing" // BUILDING_FROM_SD
  | "paused" // one of pausedStatuses
  | "notPrinting"; // anything but a print (or within the cancel window)

export interface CommandSpec {
  command: ControllerCommand;
  label: string;
  gcode: string[];
  protocolVerified: boolean;
  /** Needs this allowUnverified flag. */
  flag?: UnverifiedFlag;
  readOnly: boolean;
  state: StateRule;
  /** "print-token": a PrintAuthorization; "heater": approvedBy for heating. */
  approval?: "print-token" | "heater";
  /** Repeated requests are debounced (minCommandIntervalMs). */
  rateLimited: boolean;
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  { command: "readStatus", label: "Read status", gcode: ["M119", "M105", "M114", "M27"], protocolVerified: true, readOnly: true, state: "any", rateLimited: false },
  { command: "readInfo", label: "Printer info", gcode: ["M115"], protocolVerified: true, readOnly: true, state: "any", rateLimited: false },
  { command: "listFiles", label: "List files", gcode: ["M661"], protocolVerified: true, readOnly: false, state: "any", rateLimited: false },
  { command: "uploadFile", label: "Upload file", gcode: ["M28", "M29"], protocolVerified: true, readOnly: false, state: "ready", approval: "print-token", rateLimited: false },
  { command: "startPrint", label: "Start print", gcode: ["M23"], protocolVerified: true, readOnly: false, state: "ready", approval: "print-token", rateLimited: false },
  { command: "pause", label: "Pause", gcode: ["M25"], protocolVerified: false, readOnly: false, state: "printing", rateLimited: false },
  { command: "resume", label: "Resume", gcode: ["M24"], protocolVerified: false, readOnly: false, state: "paused", approval: "print-token", rateLimited: false },
  { command: "cancel", label: "Cancel print", gcode: ["M26"], protocolVerified: true, readOnly: false, state: "any", rateLimited: false },
  { command: "home", label: "Home axes", gcode: ["G28"], protocolVerified: true, readOnly: false, state: "idle", rateLimited: true },
  { command: "setLight", label: "Light", gcode: ["M146"], protocolVerified: false, flag: "light", readOnly: false, state: "any", rateLimited: true },
  { command: "setFan", label: "Fan", gcode: ["M106", "M107"], protocolVerified: false, flag: "fan", readOnly: false, state: "any", rateLimited: true },
  { command: "setNozzleTemp", label: "Nozzle temperature", gcode: ["M104"], protocolVerified: false, flag: "temperatures", readOnly: false, state: "notPrinting", approval: "heater", rateLimited: true },
  { command: "setBedTemp", label: "Bed temperature", gcode: ["M140"], protocolVerified: false, flag: "temperatures", readOnly: false, state: "notPrinting", approval: "heater", rateLimited: true },
  { command: "coolDown", label: "Cool down", gcode: ["M104", "M140"], protocolVerified: false, flag: "temperatures", readOnly: false, state: "notPrinting", rateLimited: false },
  { command: "motorsOff", label: "Motors off", gcode: ["M18"], protocolVerified: false, flag: "motors", readOnly: false, state: "idle", rateLimited: true },
  { command: "emergencyStop", label: "Emergency stop", gcode: ["M26", "M104", "M140"], protocolVerified: false, readOnly: false, state: "any", rateLimited: false },
];

export function commandSpec(command: ControllerCommand): CommandSpec {
  return COMMAND_SPECS.find((s) => s.command === command)!;
}

export interface CommandCapability extends CommandSpec {
  /** Controller enabled (or read-only) and, for unverified commands, its flag is on. */
  enabled: boolean;
  /** enabled, and the last known printer state permits it right now. */
  allowedNow: boolean;
  /** Why it is not allowed now. */
  reason?: string;
}

export interface CapabilityContext {
  controllerEnabled: boolean;
  flags: UnverifiedCommandFlags;
  status?: PrinterStatus;
  pausedStatuses: string[];
  /** A cancel was sent recently, so cooling down is allowed whatever the status says. */
  recentCancel: boolean;
  /** ms until this command may be sent again (0 = now); "busy" when one is already running. */
  wait: (c: ControllerCommand) => number | "busy";
}

/**
 * Paused: MachineStatus is one of `pausedStatuses`, or MoveMode reports PAUSED. FlashForge
 * firmware (and the QD330) can keep MachineStatus at BUILDING_FROM_SD while paused and only
 * flip MoveMode — the open FlashForge clients treat either as paused.
 */
export function isPausedStatus(st: { machine?: string; moveMode?: string } | undefined, pausedStatuses: string[]): boolean {
  return pausedStatuses.includes(st?.machine ?? "") || String(st?.moveMode ?? "").toUpperCase() === "PAUSED";
}

/** Printing and not paused. */
export function isBuilding(st: { machine?: string; moveMode?: string } | undefined, pausedStatuses: string[]): boolean {
  return st?.machine === "BUILDING_FROM_SD" && !isPausedStatus(st, pausedStatuses);
}

export function isPrinting(st: PrinterStatus | undefined, pausedStatuses: string[]): boolean {
  return st?.machine === "BUILDING_FROM_SD" || isPausedStatus(st, pausedStatuses);
}

/** Checks a StateRule against a status. Returns a reason when it is not met. */
export function stateProblem(rule: StateRule, st: PrinterStatus | undefined, pausedStatuses: string[], recentCancel: boolean): string | undefined {
  if (rule === "any") return undefined;
  if (!st || !st.online) return st?.error ? `printer offline: ${st.error}` : "printer status not known yet";
  const m = st.machine ?? "unknown";
  switch (rule) {
    case "ready":
      return m === "READY" ? undefined : `printer is ${m}; needs READY`;
    case "idle":
      if (m !== "READY") return `printer is ${m}; needs READY (refused while printing)`;
      return st.moveMode === "MOVING" ? "printer is moving" : undefined;
    case "printing":
      if (isPausedStatus(st, pausedStatuses)) return "the print is already paused";
      return m === "BUILDING_FROM_SD" ? undefined : `printer is ${m}; nothing to pause`;
    case "paused":
      return isPausedStatus(st, pausedStatuses) ? undefined : `printer is ${m}; nothing to resume`;
    case "notPrinting":
      return isPrinting(st, pausedStatuses) && !recentCancel ? `printer is ${m}; temperatures are not changed during a print` : undefined;
  }
}

export function describeCapabilities(ctx: CapabilityContext): CommandCapability[] {
  return COMMAND_SPECS.map((spec) => {
    const enabled = spec.readOnly || (ctx.controllerEnabled && (!spec.flag || ctx.flags[spec.flag] === true));
    let reason: string | undefined;
    if (!spec.readOnly && !ctx.controllerEnabled) reason = "printer control is disabled";
    else if (!enabled) reason = `unverified command; enable allowUnverified.${spec.flag} after checking it at the printer`;
    else {
      reason = stateProblem(spec.state, ctx.status, ctx.pausedStatuses, ctx.recentCancel);
      // Heating needs READY; cooling only needs "not printing".
      if (!reason && spec.approval === "heater" && ctx.status?.machine !== "READY") reason = `printer is ${ctx.status?.machine}; heating needs READY`;
      if (!reason) {
        const w = ctx.wait(spec.command);
        if (w === "busy") reason = "already in progress";
        else if (w > 0) reason = `repeated request; try again in ${w} ms`;
      }
    }
    return { ...spec, gcode: [...spec.gcode], enabled, allowedNow: enabled && !reason, reason };
  });
}
