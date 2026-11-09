import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src"),
  publicDir: resolve(__dirname, "public"),
  base: "./",
  plugins: [react()],
  resolve: { alias: [{ find: /^@morphix\/(.*)$/, replacement: resolve(__dirname, "../../packages/$1/src") }] },
  build: { outDir: resolve(__dirname, "dist/renderer"), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
