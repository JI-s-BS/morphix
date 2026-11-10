// Printer driver contract. Every printer family (Klipper/Moonraker, OctoPrint, Bambu LAN, ...)
// is one PrinterDriver. The server only talks to printers through this interface.
// Rules (docs/GOAL.md): no control command is sent unless the printer's state allows it; set
// temperatures are clamped by the caller to the catalog model's max; nothing is ever printed
// without the user starting it; drivers never log secrets (access codes, API keys, passwords).

export type DriverId =
  // family "http" (packages/printer/src/drivers/http)
  | "moonraker" | "octoprint" | "prusalink" | "duet"
  // family "lan" (packages/printer/src/drivers/lan)
  | "bambu-lan" | "elegoo-sdcp" | "creality-k1" | "flashforge-http" | "flashforge-tcp"
  // family "serial" (packages/printer/src/drivers/serial)
  | "marlin-serial" | "ultimaker" | "snapmaker";

export type FileFormat = "gcode" | "gx" | "gcode.3mf" | "ufp";

/** One input on the setup page's "connect printer" form. */
export interface ConnectionField {
  key: string;
  label: string;
  kind: "host" | "port" | "text" | "secret" | "number" | "serial-port" | "boolean";
  required: boolean;
  default?: string | number | boolean;
  /** One plain sentence: where the user finds this value on their printer. */
  help?: string;
}

/** Values the user entered for `fields` (secrets included; never log them). */
export type DriverConfig = Record<string, string | number | boolean | undefined>;

export type PrintState = "offline" | "idle" | "heating" | "printing" | "paused" | "finishing" | "error" | "busy";

export interface Temp { actual: number; target?: number }

export interface DriverStatus {
  state: PrintState;
  /** Short human text for the UI ("Printing benchy.gcode", "Door open"). */
  message?: string;
  temps?: { nozzle?: Temp; bed?: Temp; chamber?: Temp };
  job?: {
    file?: string;
    /** 0..1 */
    progress?: number;
    layer?: [current: number, total: number];
    elapsedS?: number;
    remainingS?: number;
  };
  checkedAt: string;
}

export interface DriverCapabilities {
  fileFormats: FileFormat[];
  upload: boolean;
  startPrint: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  setTemperature: boolean;
  gcodeConsole: boolean;
  /** How the printer's own camera can be shown, if it has one. */
  camera: false | { kind: "mjpeg" | "snapshot" | "rtsp"; url: string };
}

export type DriverErrorCode = "unreachable" | "auth" | "rejected" | "unsupported" | "busy" | "timeout" | "protocol";

export class DriverError extends Error {
  constructor(readonly code: DriverErrorCode, message: string, readonly hint?: string) {
    super(message);
    this.name = "DriverError";
  }
}

export type TestResult =
  | { ok: true; info: { model?: string; firmware?: string; serial?: string; name?: string } }
  | { ok: false; code: DriverErrorCode; message: string; hint?: string };

export interface PrinterConnection {
  readonly driver: DriverId;
  capabilities(): DriverCapabilities;
  /** Reaches the printer and checks the credentials. Never throws: returns ok:false instead. */
  test(): Promise<TestResult>;
  /** Never throws for an unreachable printer: returns state "offline" with a message. */
  status(): Promise<DriverStatus>;
  /** Uploads a sliced file. Throws DriverError. */
  upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void>;
  /** Starts a file already on the printer. Throws DriverError("busy") unless idle. */
  start(fileName: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  setTemperature?(heater: "nozzle" | "bed", celsius: number): Promise<void>;
  sendGcode?(line: string): Promise<string>;
  close(): Promise<void>;
}

export interface DriverDeps {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  log?: (level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface Discovered {
  driver: DriverId;
  host: string;
  port?: number;
  name?: string;
  model?: string;
  serial?: string;
}

export interface PrinterDriver {
  id: DriverId;
  /** "Klipper (Moonraker)" */
  name: string;
  /** One sentence for the setup page. */
  description: string;
  fields: ConnectionField[];
  /** Finds printers of this kind on the LAN (mDNS / SSDP / UDP broadcast). Optional. */
  discover?(timeoutMs: number): Promise<Discovered[]>;
  connect(config: DriverConfig, deps?: DriverDeps): PrinterConnection;
}
