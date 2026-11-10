// Setup gate (owned by the setup session, docs/GOAL.md). Shows the first-run setup wizard
// until setup is complete, then the app. Stub until that session fills it in.
import type { ReactNode } from "react";

export function SetupGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
