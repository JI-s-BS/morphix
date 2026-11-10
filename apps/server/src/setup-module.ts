// The setup / auth module (packages/config, built by the setup session). The server uses its
// exports when they exist and falls back to safe defaults when they don't:
//   createConfigStore(dataDir)            → ConfigStore
//   createAuthProvider(store)             → AuthProvider
//   createSetupRoutes({ store, auth, csrfToken, slicerAdapters }) → RouteModule | RouteModule[]
//   resetAdmin(store)                     → Promise<string | void>   (`server.cjs reset-admin`; the text holds a
//                                           one-time password: printed to the terminal once, never logged)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import * as configModule from "@morphix/config";
import type { AuthProvider, AuthUser, ConfigStore, MorphixConfig, RouteModule } from "@morphix/config";
import type { SlicerAdapter } from "@morphix/slicing";

export interface SetupModule {
  createConfigStore?: (dataDir: string) => ConfigStore;
  createAuthProvider?: (store: ConfigStore) => AuthProvider;
  createSetupRoutes?: (deps: { store: ConfigStore; auth: AuthProvider; csrfToken: (req: IncomingMessage) => string; slicerAdapters?: readonly SlicerAdapter[] }) => RouteModule | RouteModule[];
  resetAdmin?: (store: ConfigStore) => Promise<string | void> | string | void;
}

export function loadSetupModule(mod: unknown = configModule): SetupModule {
  const m = mod as Record<string, unknown>;
  const fn = <T>(k: string) => (typeof m[k] === "function" ? (m[k] as T) : undefined);
  return {
    createConfigStore: fn("createConfigStore"),
    createAuthProvider: fn("createAuthProvider"),
    createSetupRoutes: fn("createSetupRoutes"),
    resetAdmin: fn("resetAdmin"),
  };
}

export const DEFAULT_CONFIG: MorphixConfig = {
  version: 1,
  server: { port: 8080, bind: "0.0.0.0", https: false },
  printers: [],
  slicer: {},
  features: { voice: true, aiGeneration: true, modelSearch: true, guardian: true },
  setupComplete: false,
};

/**
 * Used only until packages/config provides a store: reads <dataDir>/config.json if present,
 * keeps no secrets (keys still come from the environment / config/morphix.env) and never writes.
 */
export class ReadOnlyConfigStore implements ConfigStore {
  constructor(readonly dataDir: string) {}

  async load(): Promise<MorphixConfig> {
    const file = join(this.dataDir, "config.json");
    if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
    const c = JSON.parse(readFileSync(file, "utf8")) as Partial<MorphixConfig>;
    return { ...structuredClone(DEFAULT_CONFIG), ...c, server: { ...DEFAULT_CONFIG.server, ...c.server } };
  }
  async save(): Promise<void> {
    throw new Error("The setup module isn't installed, so settings can't be saved.");
  }
  async getSecret(): Promise<string | undefined> {
    return undefined;
  }
  async setSecret(): Promise<void> {
    throw new Error("The setup module isn't installed, so keys can't be saved.");
  }
  async secretStatus(): Promise<Record<string, boolean>> {
    return {};
  }
}

/** Nobody is signed in: every "user" / "admin" route answers 401 until the setup module exists. */
export const NO_AUTH: AuthProvider = {
  userFor: async () => null,
  setupOpen: async () => false,
};

/**
 * Developer-only: everyone is the admin. The server allows it only when it listens on a loopback
 * address and MORPHIX_DEV_NO_AUTH=1 is set.
 */
export const DEV_LOOPBACK_AUTH: AuthProvider = {
  userFor: async (): Promise<AuthUser> => ({ name: "developer", role: "admin" }),
  setupOpen: async () => false,
};

export function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}
