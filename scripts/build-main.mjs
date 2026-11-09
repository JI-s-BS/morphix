// Bundles the Electron main + preload processes (TypeScript -> CommonJS).
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  external: ["electron", "sql.js", "pg", "pg-native"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["apps/desktop/electron/main.ts"], outfile: "apps/desktop/dist/main.cjs" });
await build({ ...common, entryPoints: ["apps/desktop/electron/preload.ts"], outfile: "apps/desktop/dist/preload.cjs" });
