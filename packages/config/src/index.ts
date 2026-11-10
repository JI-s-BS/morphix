// @morphix/config: settings + secret store, accounts / sign-in, and the setup API (docs/GOAL.md items 5, 10).
// The server mounts: const store = createConfigStore(dataDir); const auth = createAuth(store);
// auth.routes(router); setupRoutes({ store, auth, issues: store.issues })(router).
export * from "./types";
export { createConfigStore, defaultConfig, validateConfig, legacyEnvCandidates, parseEnvFile, isSecretKey, SLICER_IDS, type FileConfigStore, type ConfigStoreOptions, type StoreIssue } from "./store";
export { createAuth, resetAdmin, CorruptUsersFile, allowed, guarded, hashPassword, verifyPassword, parseCookies, SESSION_COOKIE, type Auth, type AuthOptions, type LoginResult } from "./auth";
export { setupRoutes, scrub, FEATURE_KEYS, SLICER_NAMES, DOCS_BASE, type SetupDeps, type SlicerChoice } from "./routes";
export { API_KEYS, testApiKey, type ApiKeyInfo, type ApiKeyName, type KeyTestResult } from "./keys";
export { InputError } from "./validate";
