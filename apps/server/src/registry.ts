// The handler registry: one table of MorphixApi handlers (by IPC channel) and one event bus.
// Electron's ipcMain and the HTTP RPC/SSE routes are both thin adapters over this.
import { toMorphixError, getErrorEntry } from "@morphix/errors";

export type Handler = (...args: unknown[]) => unknown;
export type EventListener = (channel: string, payload: unknown) => void;

export class HandlerRegistry {
  private handlers = new Map<string, Handler>();
  private listeners = new Set<EventListener>();

  handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
    if (this.handlers.has(channel)) throw new Error(`handler registered twice: ${channel}`);
    this.handlers.set(channel, fn as Handler);
  }

  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  channels(): string[] {
    return [...this.handlers.keys()];
  }

  /** Runs a handler. Errors come back coded ("MX-CODE|title|hint|detail") for the UI's error card. */
  async call(channel: string, args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`unknown call: ${channel}`);
    try {
      return await fn(...args);
    } catch (e) {
      throw coded(e);
    }
  }

  emit(channel: string, payload: unknown): void {
    for (const l of this.listeners) {
      try {
        l(channel, payload);
      } catch {
        /* one broken listener must not stop the others */
      }
    }
  }

  subscribe(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Errors cross IPC / HTTP as "MX-CODE|title|hint|detail" so the screen can show a friendly card. */
export function coded(e: unknown): Error {
  const me = toMorphixError(e);
  const entry = getErrorEntry(me.code);
  return new Error(`${me.code}|${entry?.title ?? me.title}|${entry?.hint ?? me.hint}|${(e as Error)?.message ?? ""}`);
}
