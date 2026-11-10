// Lookup and extension of the error-code registry. Other packages (photo3d owns the
// MX-P3D series) add their codes at start-up with registerErrorCodes().
import { CORE_ERROR_CODES, ERROR_AREAS, type ErrorArea, type ErrorCodeEntry, type ErrorSeverity } from "./codes";

/** `MX-<AREA>-<nnn>`; the registry decides whether a given code exists. */
export type ErrorCode = `MX-${string}-${string}`;

export const ERROR_CODE_PATTERN = /^MX-([A-Z][A-Z0-9]*)-(\d{3})$/;
const SEVERITIES: readonly ErrorSeverity[] = ["info", "warning", "error", "critical"];

const registry = new Map<string, ErrorCodeEntry>();
const owners = new Map<string, string>();
for (const e of CORE_ERROR_CODES) {
  registry.set(e.code, e);
  owners.set(e.code, "core");
}

export function getErrorEntry(code: string): ErrorCodeEntry | undefined {
  return registry.get(code);
}

/** True when `code` is registered (core or extension). */
export function isKnownErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && registry.has(code);
}

/** All registered entries, sorted by area (registry order) then number. */
export function listErrorCodes(filter: { area?: ErrorArea | string; core?: boolean } = {}): ErrorCodeEntry[] {
  const areaOrder = Object.keys(ERROR_AREAS);
  const rank = (a: string) => (areaOrder.includes(a) ? areaOrder.indexOf(a) : areaOrder.length);
  return [...registry.values()]
    .filter((e) => (filter.area ? e.area === filter.area : true))
    .filter((e) => (filter.core === undefined ? true : (owners.get(e.code) === "core") === filter.core))
    .sort((a, b) => rank(a.area) - rank(b.area) || a.area.localeCompare(b.area) || a.code.localeCompare(b.code));
}

export interface RegisterOptions {
  /** Who owns these codes (shown in errors and duplicates), e.g. "packages/photo3d". */
  owner: string;
}

export type ErrorCodeInput = Omit<ErrorCodeEntry, "area"> & { area?: string };

/**
 * Adds extension codes (e.g. MX-P3D-001 from packages/photo3d). Core codes can never be
 * replaced; registering an identical entry again is a no-op so hot reloads are safe.
 * Throws on a malformed entry or a conflicting duplicate.
 */
export function registerErrorCodes(entries: readonly ErrorCodeInput[], opts: RegisterOptions): ErrorCodeEntry[] {
  const out: ErrorCodeEntry[] = [];
  const pending = new Map<string, ErrorCodeEntry>();
  for (const input of entries) {
    const m = ERROR_CODE_PATTERN.exec(input.code);
    if (!m) throw new TypeError(`invalid error code "${input.code}" (expected MX-<AREA>-<nnn>)`);
    if (input.area && input.area !== m[1]) throw new TypeError(`${input.code}: area "${input.area}" does not match the code`);
    if (!input.title?.trim() || !input.hint?.trim() || !input.description?.trim()) throw new TypeError(`${input.code}: title, hint and description are required`);
    if (!SEVERITIES.includes(input.severity)) throw new TypeError(`${input.code}: invalid severity "${input.severity}"`);
    if (typeof input.retryable !== "boolean") throw new TypeError(`${input.code}: retryable must be a boolean`);
    const entry: ErrorCodeEntry = {
      code: input.code,
      area: m[1] as ErrorArea,
      title: input.title,
      hint: input.hint,
      description: input.description,
      severity: input.severity,
      retryable: input.retryable,
    };
    const existing = registry.get(entry.code) ?? pending.get(entry.code);
    if (existing) {
      const same = JSON.stringify(existing) === JSON.stringify(entry);
      const owner = owners.get(entry.code) ?? opts.owner;
      if (owner === "core") throw new Error(`${entry.code} is a core Morphix code and cannot be re-registered`);
      if (!same || owner !== opts.owner) throw new Error(`${entry.code} is already registered by ${owner}`);
      out.push(existing);
      continue;
    }
    pending.set(entry.code, entry);
    out.push(entry);
  }
  for (const [code, e] of pending) {
    registry.set(code, Object.freeze(e));
    owners.set(code, opts.owner);
  }
  return out;
}

/** Owner of a registered code ("core" for built-in codes). */
export function errorCodeOwner(code: string): string | undefined {
  return owners.get(code);
}

/** Removes extension codes (tests only). Core codes stay. */
export function unregisterErrorCodes(owner: string): void {
  if (owner === "core") return;
  for (const [code, o] of owners) {
    if (o === owner) {
      owners.delete(code);
      registry.delete(code);
    }
  }
}
