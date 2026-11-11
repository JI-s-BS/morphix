// MorphixApi over HTTP: POST /api/rpc/<channel> with a JSON args array (binary as { $bytes }),
// reply { result }; push events stream from GET /api/events as Server-Sent Events.
import type { IncomingMessage } from "node:http";
import type { AuthProvider } from "@morphix/config";
import { IPC, EVENT_CHANNELS, decodeWire, encodeWire } from "@morphix/shared";
import type { HandlerRegistry } from "./registry";
import { HttpError, type MorphixRouter } from "./router";

const MB = 1_000_000;
/** Body limits for the calls that carry audio, images or model files (others: 256 KB). */
export const RPC_BODY_LIMITS: Record<string, number> = {
  [IPC.voiceTurn]: 8 * MB, // 2 min of 16 kHz PCM, base64
  [IPC.submitRecording]: 8 * MB,
  [IPC.saveThumbnail]: 8 * MB,
  [IPC.importSmartModel]: 140 * MB, // up to ~100 MB of model files, base64
  [IPC.importModelFiles]: 140 * MB,
};
const DEFAULT_RPC_LIMIT = 256_000;

const EVENT_SET = new Set<string>(EVENT_CHANNELS);

export interface RpcOptions {
  auth: AuthProvider;
  /** Most open event streams at once (all browsers together). */
  maxStreams?: number;
  heartbeatMs?: number;
}

export function mountRpc(router: MorphixRouter, registry: HandlerRegistry, o: RpcOptions): { closeStreams(): void } {
  const channels = Object.values(IPC).filter((c) => !EVENT_SET.has(c));
  for (const channel of channels) {
    router.add(
      "POST",
      `/api/rpc/${channel}`,
      "user",
      async (ctx) => {
        if (!registry.has(channel)) throw new HttpError(501, "not_implemented", `${channel} isn't available on this server.`);
        const raw = await ctx.json<unknown>();
        const args = raw === undefined ? [] : raw;
        if (!Array.isArray(args) || args.length > 8) throw new HttpError(400, "bad_args", "Expected a JSON array of arguments.");
        let result: unknown;
        try {
          result = await registry.call(channel, decodeWire(args) as unknown[]);
        } catch (e) {
          ctx.send(400, { error: { code: "rpc", message: (e as Error).message } });
          return;
        }
        ctx.send(200, { result: result === undefined ? null : encodeWire(result) });
      },
      { maxBodyBytes: RPC_BODY_LIMITS[channel] ?? DEFAULT_RPC_LIMIT },
    );
  }

  const streams = new Set<() => void>();
  const maxStreams = o.maxStreams ?? 64;
  const heartbeatMs = o.heartbeatMs ?? 25_000;
  router.add("GET", "/api/events", "user", (ctx) => {
    if (streams.size >= maxStreams) throw new HttpError(503, "busy", "Too many open Morphix pages.", "Close some Morphix tabs and reload.");
    const { req, res } = ctx;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const unsubscribe = registry.subscribe((channel, payload) => {
      if (!EVENT_SET.has(channel)) return;
      res.write(`event: ${channel}\ndata: ${JSON.stringify(encodeWire(payload))}\n\n`);
    });
    // Re-check the sign-in on every heartbeat, so a signed-out browser stops getting events.
    const beat = setInterval(() => {
      void stillSignedIn(o.auth, req).then((ok) => (ok ? res.write(": ping\n\n") : close()));
    }, heartbeatMs);
    const close = () => {
      clearInterval(beat);
      unsubscribe();
      streams.delete(close);
      if (!res.writableEnded) res.end();
    };
    streams.add(close);
    req.on("close", close);
    res.on("close", close);
  });
  return { closeStreams: () => [...streams].forEach((c) => c()) };
}

async function stillSignedIn(auth: AuthProvider, req: IncomingMessage): Promise<boolean> {
  try {
    return (await auth.userFor(req)) !== null;
  } catch {
    return false;
  }
}
