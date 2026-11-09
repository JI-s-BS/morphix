// IPC errors arrive as "MX-CODE|title|hint|detail" (see coded() in the main process).
export interface FriendlyError {
  code?: string;
  title: string;
  hint?: string;
  detail?: string;
}

export function friendlyError(e: unknown): FriendlyError {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /(MX-[A-Z0-9]+-\d{3})\|([^|]*)\|([^|]*)\|?(.*)$/s.exec(raw);
  if (m) return { code: m[1], title: m[2], hint: m[3], detail: m[4] };
  return { title: raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") };
}
