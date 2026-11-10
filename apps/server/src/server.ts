// Headless Morphix: `node apps/server/dist/server.cjs` (systemd service or Docker).
//   MORPHIX_DATA_DIR  data dir (default ~/.local/share/morphix)
//   MORPHIX_PORT      port (default: setup page's value, else 8080)
//   MORPHIX_BIND      address (default: setup page's value, else 0.0.0.0)
//   `server.cjs reset-admin`  runs the setup module's admin reset and exits.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthProvider, ConfigStore } from "@morphix/config";
import { createCore, readVersion } from "./core";
import { createHttpApp } from "./http";
import { mountRoutes } from "./router";
import { DEV_LOOPBACK_AUTH, NO_AUTH, ReadOnlyConfigStore, isLoopback, loadSetupModule } from "./setup-module";
import { installedAdapters } from "./slicers";
import { selfSignedCert } from "./tls";

export function dataDirFromEnv(env = process.env): string {
  return resolve(env.MORPHIX_DATA_DIR?.trim() || join(homedir(), ".local", "share", "morphix"));
}

/** Install root: holds package.json, config/slicer-profiles, apps/desktop/dist/renderer. */
function appRoot(): string {
  return resolve(process.env.MORPHIX_APP_ROOT?.trim() || resolve(__dirname, "..", "..", ".."));
}

/** Stable random key for CSRF tokens, created once (mode 0600). */
export function serverSecret(dataDir: string): string {
  const file = join(dataDir, "server-secret");
  if (existsSync(file)) {
    const s = readFileSync(file, "utf8").trim();
    if (s.length >= 32) return s;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const s = randomBytes(32).toString("base64url");
  writeFileSync(file, s + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return s;
}

async function resetAdmin(store: ConfigStore): Promise<number> {
  const setup = loadSetupModule();
  if (!setup.resetAdmin) {
    console.error("This Morphix build has no admin reset (the setup module isn't installed).");
    return 1;
  }
  const out = await setup.resetAdmin(store);
  console.log(typeof out === "string" && out ? out : "Admin account reset. Open Morphix in a browser to create a new admin password.");
  return 0;
}

async function main(argv: string[]): Promise<void> {
  const dataDir = dataDirFromEnv();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const setup = loadSetupModule();
  const store: ConfigStore = setup.createConfigStore?.(dataDir) ?? new ReadOnlyConfigStore(dataDir);

  if (argv[0] === "reset-admin") process.exit(await resetAdmin(store));
  if (argv[0] && argv[0] !== "serve") {
    console.error(`Unknown command: ${argv[0]}. Usage: server.cjs [serve | reset-admin]`);
    process.exit(2);
  }

  const config = await store.load().catch((e) => {
    console.error(`Settings couldn't be read (${(e as Error).message}); using defaults.`);
    return null;
  });
  const port = Number(process.env.MORPHIX_PORT?.trim() || config?.server.port || 8080);
  const bind = process.env.MORPHIX_BIND?.trim() || config?.server.bind || "0.0.0.0";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MORPHIX_PORT must be 1-65535 (got ${process.env.MORPHIX_PORT})`);
  const root = appRoot();
  const version = readVersion(root);

  const core = await createCore({ dataDir, repoRoot: root, version, store, config });
  const log = core.log;
  process.on("uncaughtException", (e) => log.write("error", "uncaughtException", { message: e.message, stack: e.stack }));
  process.on("unhandledRejection", (e) => log.write("error", "unhandledRejection", { reason: String(e) }));

  let auth: AuthProvider;
  if (setup.createAuthProvider) auth = setup.createAuthProvider(store);
  else if (process.env.MORPHIX_DEV_NO_AUTH === "1" && isLoopback(bind)) {
    auth = DEV_LOOPBACK_AUTH;
    log.write("warn", "MORPHIX_DEV_NO_AUTH=1: no sign-in (loopback only, for development)");
  } else {
    auth = NO_AUTH;
    log.write("warn", "the setup / sign-in module isn't installed: only /api/health and the page itself are reachable");
  }

  const https = config?.server.https === true;
  const app = createHttpApp({
    registry: core.registry,
    auth,
    secret: serverSecret(dataDir),
    version,
    rendererDir: join(root, "apps", "desktop", "dist", "renderer"),
    storageRoot: core.storage.root,
    camera: core.camera,
    secureCookies: https,
    log: (level, message, extra) => log.write(level, message, extra),
  });
  const csrfToken = (req: import("node:http").IncomingMessage) => app.router.csrfToken(req);
  if (setup.createSetupRoutes) {
    mountRoutes(app.router, setup.createSetupRoutes({ store, auth, csrfToken, slicerAdapters: installedAdapters() }));
  }

  let server: Server;
  if (https) {
    const tls = await selfSignedCert(dataDir);
    server = createHttps({ key: tls.key, cert: tls.cert }, app.handler) as unknown as Server;
  } else server = createHttp(app.handler);
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // event streams and large uploads; the router limits body sizes

  await core.start();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, bind, () => ok());
  });
  const url = `${https ? "https" : "http"}://${bind === "0.0.0.0" || bind === "::" ? "<this-machine>" : bind}:${port}`;
  log.write("info", "Morphix server listening", { url, dataDir, version });
  console.log(`Morphix ${version} is running at ${url} (data: ${dataDir})`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.write("info", "shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.closeStreams();
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    server.closeIdleConnections?.();
    await closed;
    await core.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`Morphix server failed to start: ${(e as Error).message}`);
    process.exit(1);
  });
}
