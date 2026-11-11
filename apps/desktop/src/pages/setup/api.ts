// Browser side of the setup / auth API (packages/config routes). Every non-GET request carries
// the CSRF header the server checks: the value comes from the readable `morphix_csrf` cookie, or
// from GET /api/session when the cookie isn't there.
import type { ConnectionField, Discovered, DriverId, TestResult } from "@morphix/printer";
import type { SlicerId } from "@morphix/slicing";

export interface SessionUser { name: string; role: "admin" | "user" }
export interface Me { user: SessionUser | null; setupOpen: boolean; mustChangePassword: boolean }

export interface Status {
  setupOpen: boolean;
  setupComplete: boolean;
  steps?: { admin: boolean; printer: boolean; slicer: boolean; keys: boolean };
  printers?: number;
  activePrinterId?: string | null;
  slicer?: SlicerId | null;
  keys?: Record<string, boolean>;
  features?: Features;
  issues?: string[];
}

export interface Features { voice: boolean; aiGeneration: boolean; modelSearch: boolean; guardian: boolean }

export interface CatalogModel {
  id: string; brand: string; model: string; driver: DriverId; altDrivers: DriverId[]; verified: "tested" | "protocol";
  setupDoc?: string; docUrl?: string; driverAvailable: boolean;
}
export interface CatalogDriver { id: DriverId; name: string; description: string; fields: ConnectionField[]; canDiscover: boolean }
export interface Catalog { brands: { brand: string; models: CatalogModel[] }[]; drivers: CatalogDriver[] }

export interface SavedPrinter {
  id: string; name: string; modelId: string; driver: DriverId; driverName: string; driverAvailable: boolean;
  connection: Record<string, string | number | boolean>;
  secretFields: Record<string, boolean>;
}

export interface KeyInfo { key: string; label: string; unlocks: string; getUrl: string; set: boolean }
export interface SlicerChoice { id: SlicerId; name: string; installed: boolean | null; version?: string | null; path?: string; hint?: string; supportsActivePrinter?: boolean }
export type KeyTest = { ok: true; message: string } | { ok: false; message: string; hint?: string };
export type FoundPrinter = Discovered & { models: string[] };
export type { TestResult };

export class ApiError extends Error {
  /** status 0 = server unreachable; -1 = something answered, but it isn't the Morphix API. */
  constructor(message: string, readonly status: number, readonly field?: string) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfCache: string | null = null;

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Forget the cached CSRF token (after sign-in / sign-out the server may issue a new one). */
export function resetCsrf(): void {
  csrfCache = null;
}

async function csrfToken(): Promise<string> {
  const fromCookie = readCookie("morphix_csrf");
  if (fromCookie) return fromCookie;
  if (!csrfCache) {
    try {
      const r = await fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
      const j = (await r.json()) as { csrf?: unknown };
      if (typeof j.csrf === "string") csrfCache = j.csrf;
    } catch {
      // the request below will fail with the server's own message
    }
  }
  return csrfCache ?? "";
}

export async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-Morphix-CSRF"] = await csrfToken();
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Can't reach the Morphix server. Check that it's running and that this device is on the same network.", 0);
  }
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new ApiError(res.ok ? "This page isn't connected to a Morphix server." : `The Morphix server answered with an error (HTTP ${res.status}).`, res.ok || res.status === 404 ? -1 : res.status);
  }
  const data = (await res.json()) as T & { error?: string; field?: string };
  if (!res.ok) {
    if (res.status === 403) resetCsrf();
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data.field);
  }
  return data;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
