import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// `npm run dev:renderer` talks to a running Morphix server (MORPHIX_DEV_SERVER, default
// http://127.0.0.1:8080); VITE_MORPHIX_MOCK=1 previews the UI with the in-browser mock instead.
const devServer = process.env.MORPHIX_DEV_SERVER || "http://127.0.0.1:8080";

export default defineConfig({
  root: resolve(__dirname, "src"),
  publicDir: resolve(__dirname, "public"),
  base: "/",
  plugins: [react()],
  resolve: { alias: [{ find: /^@morphix\/(.*)$/, replacement: resolve(__dirname, "../../packages/$1/src") }] },
  build: { outDir: resolve(__dirname, "dist/renderer"), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { "/api": { target: devServer, changeOrigin: false }, "/library": { target: devServer, changeOrigin: false } } },
});
