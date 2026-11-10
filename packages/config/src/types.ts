// Contracts shared by the headless server (apps/server) and the setup/auth module
// (packages/config). See docs/GOAL.md. Implementation: packages/config/src/*.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DriverId } from "@morphix/printer";
import type { SlicerId } from "@morphix/slicing";

export interface ConfiguredPrinter {
  /** Random id. */
  id: string;
  /** The user's name for it ("Garage Ender"). */
  name: string;
  /** Catalog model id (packages/catalog). */
  modelId: string;
  driver: DriverId;
  /** Non-secret connection values (host, port, serial). Secret fields live in the secret store as `printer:<id>:<key>`. */
  connection: Record<string, string | number | boolean>;
}

export interface MorphixConfig {
  version: 1;
  server: { port: number; bind: string; https: boolean };
  printers: ConfiguredPrinter[];
  activePrinterId?: string;
  slicer: { preferred?: SlicerId; paths?: Partial<Record<SlicerId, string>> };
  /** Optional features; each needs its key to be set. */
  features: { voice: boolean; aiGeneration: boolean; modelSearch: boolean; guardian: boolean };
  setupComplete: boolean;
}

/** API keys the setup page manages. Values never leave the server; the UI only sees set / not set. */
export const SECRET_KEYS = ["GEMINI_API_KEY", "MESHY_API_KEY", "ANTHROPIC_API_KEY", "THINGIVERSE_TOKEN"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number] | `printer:${string}:${string}`;

export interface ConfigStore {
  readonly dataDir: string;
  load(): Promise<MorphixConfig>;
  save(config: MorphixConfig): Promise<void>;
  getSecret(key: SecretKey): Promise<string | undefined>;
  /** null deletes it. */
  setSecret(key: SecretKey, value: string | null): Promise<void>;
  /** Which secrets are set. Never returns values. */
  secretStatus(): Promise<Record<string, boolean>>;
}

// ------------------------------------------------------------------ HTTP ---
export interface AuthUser { name: string; role: "admin" | "user" }

/**
 * public: anyone on the network. setup: only while setup is not complete (first run), else admin.
 * user / admin: signed in.
 */
export type Access = "public" | "setup" | "user" | "admin";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  user: AuthUser | null;
  /** Body, size-limited by the server. */
  body(): Promise<Buffer>;
  json<T = unknown>(): Promise<T>;
  /** JSON reply (Buffer/string sent as-is). */
  send(status: number, body?: unknown, headers?: Record<string, string>): void;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface Router {
  /** pattern like "/api/printers/:id". Non-GET routes require the CSRF header (server-enforced). */
  add(method: "GET" | "POST" | "PUT" | "DELETE", pattern: string, access: Access, handler: RouteHandler): void;
}

/** Implemented in packages/config (auth.ts); the server calls it for every request. */
export interface AuthProvider {
  userFor(req: IncomingMessage): Promise<AuthUser | null>;
  /** True until the first admin account exists. */
  setupOpen(): Promise<boolean>;
}

export type RouteModule = (router: Router) => void;
