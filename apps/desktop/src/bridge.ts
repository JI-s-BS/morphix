import type { MorphixApi } from "@morphix/shared";
import { createMockApi } from "./mock";

declare global {
  interface Window {
    morphix?: MorphixApi;
  }
}

/** True inside Electron; false when the UI is previewed in a plain browser. */
export const inElectron = typeof window !== "undefined" && Boolean(window.morphix);
export const api: MorphixApi = window.morphix ?? createMockApi();
