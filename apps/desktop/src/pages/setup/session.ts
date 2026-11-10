// Who is signed in (provided by SetupGate), for Settings → System setup.
import { createContext, useContext } from "react";
import type { SessionUser } from "./api";

export interface SetupSession {
  /** False when no Morphix server answers (Electron over IPC only, or a design preview). */
  available: boolean;
  user: SessionUser | null;
  setupComplete: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<SetupSession>({ available: false, user: null, setupComplete: true, refresh: async () => {}, logout: async () => {} });

export function useSetupSession(): SetupSession {
  return useContext(SessionContext);
}
