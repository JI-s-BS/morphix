// Bundles the headless server (apps/server) into one CommonJS file: apps/server/dist/server.cjs.
// sql.js stays external (it loads its .wasm from node_modules at run time).
import { build } from "esbuild";

await build({
  entryPoints: ["apps/server/src/server.ts"],
  outfile: "apps/server/dist/server.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  external: ["electron", "sql.js", "pg", "pg-native"],
  logLevel: "info",
});
