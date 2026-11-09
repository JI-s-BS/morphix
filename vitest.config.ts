import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: [{ find: /^@morphix\/(.*)$/, replacement: resolve(__dirname, "packages/$1/src") }] },
  test: { include: ["tests/**/*.test.ts"] },
});
