// Shared setup for Phase 5 tests: a fake printer on loopback and a hard guard
// that makes any attempt to reach a non-loopback host fail the test.
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll } from "vitest";
import { FakeQD330, PrintAuthorizer, QD330Controller, type ControlLogEntry, type FakeQD330Options, type QD330ControllerOptions } from "@morphix/printer";

export function guardLoopbackOnly(): void {
  const original = Socket.prototype.connect;
  beforeAll(() => {
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
      const first = args[0] as unknown;
      const host = typeof first === "object" && first !== null ? (first as { host?: string }).host : (args[1] as string | undefined);
      if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`test tried to reach a real host: ${String(host)}`);
      return (original as (...a: unknown[]) => Socket).apply(this, args);
    } as typeof Socket.prototype.connect;
  });
  afterAll(() => {
    Socket.prototype.connect = original;
  });
}

export const GX = Buffer.from("xgcode 1.0\n;fake .gx payload\n");

export interface Rig {
  fake: FakeQD330;
  auth: PrintAuthorizer;
  log: ControlLogEntry[];
  controller(extra?: Partial<QD330ControllerOptions>): QD330Controller;
}

/** Starts a fresh fake printer per test and tears it down afterwards. */
export async function startRig(opts: FakeQD330Options = {}, cleanup: (fn: () => Promise<void>) => void): Promise<Rig> {
  const fake = new FakeQD330({ files: { "Afinia_Cube.gx": GX }, ...opts });
  const port = await fake.listen();
  cleanup(() => fake.close());
  const auth = new PrintAuthorizer();
  const log: ControlLogEntry[] = [];
  return {
    fake,
    auth,
    log,
    controller: (extra = {}) =>
      new QD330Controller({
        enabled: true,
        host: "127.0.0.1",
        port,
        connectTimeoutMs: 500,
        replyTimeoutMs: 300,
        startReplyTimeoutMs: 300,
        uploadFinishTimeoutMs: 300,
        startConfirmTimeoutMs: 500,
        confirmTimeoutMs: 500,
        pauseConfirmTimeoutMs: 500,
        pollIntervalMs: 20,
        packetDelayMs: 0,
        uploadFlushDelayMs: 0,
        authorizer: auth,
        log: (e) => log.push(e),
        ...extra,
      }),
  };
}

/** Collects async cleanups for afterEach. */
export function useCleanup(): (fn: () => Promise<void>) => void {
  const fns: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (fns.length) await fns.pop()!();
  });
  return (fn) => fns.push(fn);
}
