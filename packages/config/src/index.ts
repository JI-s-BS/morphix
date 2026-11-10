// @morphix/config: settings + secret store, accounts / sign-in, and the setup API (docs/GOAL.md items 5, 10).
// The server mounts: const store = createConfigStore(dataDir); const auth = createAuth(store);
// auth.routes(router); setupRoutes({ store, auth, issues: store.issues })(router).
export * from "./types";
export { createConfigStore, defaultConfig, validateConfig, legacyEnvCandidates, parseEnvFile, isSecretKey, SLICER_IDS, type FileConfigStore, type ConfigStoreOptions, type StoreIssue } from "./store";
export { createAuth, resetAdmin, resetAdminAccount, CorruptUsersFile, allowed, guarded, hashPassword, verifyPassword, parseCookies, SESSION_COOKIE, type Auth, type AuthOptions, type LoginResult } from "./auth";
export { setupRoutes, scrub, FEATURE_KEYS, SLICER_NAMES, DOCS_BASE, type SetupDeps, type SlicerChoice } from "./routes";
export { API_KEYS, testApiKey, type ApiKeyInfo, type ApiKeyName, type KeyTestResult } from "./keys";
export { InputError } from "./validate";

// Names the server (apps/server) looks up.
import { createAuth, type Auth } from "./auth";
import { setupRoutes, type SetupDeps } from "./routes";
import type { AuthProvider, ConfigStore, RouteModule } from "./types";
import type { FileConfigStore } from "./store";

/** Same as createAuth; the returned object also carries the /api/auth/* routes. */
export const createAuthProvider = (store: ConfigStore): Auth => createAuth(store);

/** /api/auth/* (when `auth` came from createAuthProvider / createAuth) plus /api/setup/*. CSRF is the server's. */
export function createSetupRoutes(deps: { store: ConfigStore; auth: AuthProvider; csrfToken?(req: unknown): string } & Partial<Omit<SetupDeps, "store" | "auth">>): RouteModule[] {
  const { store, auth, csrfToken: _csrf, ...rest } = deps;
  const issues = rest.issues ?? (typeof (store as Partial<FileConfigStore>).issues === "function" ? () => (store as FileConfigStore).issues() : undefined);
  const mods: RouteModule[] = [];
  if (typeof (auth as Partial<Auth>).routes === "function") mods.push((auth as Auth).routes);
  mods.push(setupRoutes({ ...rest, store, auth, issues }));
  return mods;
}
