// The renderer's only bridge to Morphix: window.morphix inside the Electron kiosk (preload, IPC),
// otherwise HTTP + Server-Sent Events to the Morphix server that served this page. The in-browser
// mock is only for `vite dev` previews with VITE_MORPHIX_MOCK=1; it never touches a printer.
import { createHttpApi, type MorphixApi } from "@morphix/shared";
import { createMockApi } from "./mock";

declare global {
  interface Window {
    morphix?: MorphixApi;
  }
}

const viteEnv = (import.meta as unknown as { env?: { DEV?: boolean; VITE_MORPHIX_MOCK?: string } }).env ?? {};

/** True inside the Electron kiosk (IPC); false in a browser (HTTP). */
export const inElectron = typeof window !== "undefined" && Boolean(window.morphix);
/** True only in a `vite dev` preview started with VITE_MORPHIX_MOCK=1. */
export const usingMock = !inElectron && viteEnv.DEV === true && viteEnv.VITE_MORPHIX_MOCK === "1";

export const api: MorphixApi =
  window.morphix ??
  (usingMock
    ? createMockApi()
    : createHttpApi({
        // The setup page (SetupGate) listens for this to show sign-in / first-run setup.
        onUnauthorized: (code) => window.dispatchEvent(new CustomEvent("morphix:unauthorized", { detail: { code } })),
      }));
