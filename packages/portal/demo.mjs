// Bundles src/demo.ts with esbuild (already a dev dependency) and runs it.
// Usage from the repo root: node packages/portal/demo.mjs
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "morphix-portal-build-")), "demo.cjs");
await build({ entryPoints: [join(here, "src/demo.ts")], bundle: true, platform: "node", format: "cjs", target: "node20", outfile: out, logLevel: "warning" });
process.env.MORPHIX_PORTAL_WEB ??= join(here, "web");
process.env.MORPHIX_PORTAL_THREE ??= join(here, "../../node_modules/three");
await import(pathToFileURL(out).href);
