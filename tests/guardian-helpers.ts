// In-memory GuardianStore for guardian tests (the app persists to SQLite in apps/desktop/electron/printing.ts).
import type { Alert, EvidenceRecord, GuardianStore, SessionRecord, Transition } from "@morphix/guardian";

export class MemoryGuardianStore implements GuardianStore {
  sessions = new Map<string, SessionRecord>();
  alerts = new Map<string, Alert>();
  transitions: Transition[] = [];
  evidence: EvidenceRecord[] = [];
  sessionStarted(s: SessionRecord) {
    this.sessions.set(s.id, { ...s });
  }
  sessionEnded(s: SessionRecord) {
    this.sessions.set(s.id, { ...s });
  }
  alertChanged(a: Alert, t: Transition | null) {
    this.alerts.set(a.id, structuredClone(a));
    if (t) this.transitions.push(t);
  }
  evidenceSaved(e: EvidenceRecord) {
    this.evidence.push(e);
  }
}
