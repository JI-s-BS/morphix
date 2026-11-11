// Test fakes for the "lan" printer drivers: a tiny MQTT 3.1.1 broker on loopback, an in-memory
// WebSocket class (injected through DriverDeps.WebSocket), a fake FTPS client, and helpers.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach } from "vitest";

/** A TCP port on 127.0.0.1 with nothing listening. */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Collects async cleanups for afterEach. */
export function useCleanup(): (fn: () => unknown) => void {
  const fns: (() => unknown)[] = [];
  afterEach(async () => {
    while (fns.length) await fns.pop()!();
  });
  return (fn) => fns.push(fn);
}

export interface LogLine {
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

export function captureLog(): { lines: LogLine[]; log: (level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void; text(): string } {
  const lines: LogLine[] = [];
  return { lines, log: (level, message, data) => lines.push({ level, message, data }), text: () => JSON.stringify(lines) };
}

// ---- MQTT 3.1.1 -------------------------------------------------------------

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function mqttString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
}

export interface MqttConnect {
  clientId: string;
  username?: string;
  password?: string;
}

/** Minimal MQTT 3.1.1 broker: CONNECT/CONNACK, SUBSCRIBE/SUBACK, QoS 0 PUBLISH, PING, DISCONNECT. */
export class FakeMqttBroker {
  private server: Server;
  private clients = new Set<{ sock: Socket; subs: string[] }>();
  readonly connects: MqttConnect[] = [];
  readonly published: { topic: string; payload: string }[] = [];
  /** Return a CONNACK code (0 = accepted, 5 = not authorized), or null to never answer. */
  onConnect: (c: MqttConnect) => number | null = () => 0;
  onPublish: (topic: string, payload: string) => void = () => undefined;

  constructor() {
    this.server = createServer((sock) => this.accept(sock));
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.sock.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Sends a PUBLISH to every client subscribed to `topic`. */
  publish(topic: string, payload: unknown): void {
    const body = Buffer.concat([mqttString(topic), Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))]);
    for (const c of this.clients) if (c.subs.includes(topic)) c.sock.write(packet(3, 0, body));
  }

  private accept(sock: Socket) {
    const client = { sock, subs: [] as string[] };
    this.clients.add(client);
    let buf = Buffer.alloc(0);
    sock.on("error", () => undefined);
    sock.on("close", () => this.clients.delete(client));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let mult = 1;
        let len = 0;
        let i = 1;
        let b: number;
        do {
          if (i >= buf.length) return;
          b = buf[i++];
          len += (b & 0x7f) * mult;
          mult *= 128;
        } while (b & 0x80);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4;
        const body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        this.handle(client, type, body);
      }
    });
  }

  private handle(client: { sock: Socket; subs: string[] }, type: number, body: Buffer) {
    const readStr = (off: number): [string, number] => {
      const n = body.readUInt16BE(off);
      return [body.subarray(off + 2, off + 2 + n).toString("utf8"), off + 2 + n];
    };
    switch (type) {
      case 1: {
        let [, off] = readStr(0); // "MQTT"
        off += 1; // level
        const flags = body[off];
        off += 3; // flags + keepalive
        const [clientId, o1] = readStr(off);
        off = o1;
        if (flags & 0x04) {
          off = readStr(off)[1];
          off = readStr(off)[1];
        }
        let username: string | undefined;
        let password: string | undefined;
        if (flags & 0x80) [username, off] = readStr(off);
        if (flags & 0x40) [password, off] = readStr(off);
        const c = { clientId, username, password };
        this.connects.push(c);
        const rc = this.onConnect(c);
        if (rc === null) return;
        client.sock.write(packet(2, 0, Buffer.from([0, rc])));
        if (rc !== 0) client.sock.end();
        return;
      }
      case 3: {
        const [topic, off] = readStr(0);
        const payload = body.subarray(off).toString("utf8");
        this.published.push({ topic, payload });
        this.onPublish(topic, payload);
        return;
      }
      case 8: {
        const id = body.readUInt16BE(0);
        let off = 2;
        const granted: number[] = [];
        while (off < body.length) {
          const [topic, o] = readStr(off);
          off = o + 1;
          client.subs.push(topic);
          granted.push(0);
        }
        const head = Buffer.alloc(2);
        head.writeUInt16BE(id);
        client.sock.write(packet(9, 0, Buffer.concat([head, Buffer.from(granted)])));
        return;
      }
      case 12:
        client.sock.write(packet(13, 0, Buffer.alloc(0)));
        return;
      case 14:
        client.sock.end();
        return;
    }
  }
}

// ---- WebSocket ----------------------------------------------------------------

export interface FakeWsPeer {
  /** Text the client sent. */
  sent: string[];
  /** Push a text frame to the client. */
  push(data: unknown): void;
  /** Close from the server side. */
  close(): void;
}

/**
 * A WebSocket class for DriverDeps.WebSocket. `handler` is called with each text the client
 * sends; reply with `peer.push`. `refuse` makes every connection fail like an unreachable host.
 */
export function fakeWebSocket(handler: (text: string, peer: FakeWsPeer) => void, opts: { refuse?: boolean; neverOpen?: boolean; onOpen?: (peer: FakeWsPeer, url: string, protocols?: string | string[]) => void } = {}) {
  const peers: FakeWsPeer[] = [];
  class FakeWs extends EventTarget {
    readyState = 0;
    readonly url: string;
    private peer: FakeWsPeer;
    constructor(url: string, protocols?: string | string[]) {
      super();
      this.url = url;
      const self = this;
      this.peer = {
        sent: [],
        push(data: unknown) {
          if (self.readyState !== 1) return;
          const text = typeof data === "string" ? data : JSON.stringify(data);
          setImmediate(() => self.dispatchEvent(new MessageEvent("message", { data: text })));
        },
        close() {
          if (self.readyState === 3) return;
          self.readyState = 3;
          self.dispatchEvent(new Event("close"));
        },
      };
      peers.push(this.peer);
      setImmediate(() => {
        if (opts.neverOpen) return;
        if (opts.refuse) {
          this.readyState = 3;
          this.dispatchEvent(new Event("error"));
          this.dispatchEvent(new Event("close"));
          return;
        }
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        opts.onOpen?.(this.peer, url, protocols);
      });
    }
    send(text: string) {
      if (this.readyState !== 1) throw new Error("not open");
      this.peer.sent.push(text);
      setImmediate(() => handler(text, this.peer));
    }
    close() {
      this.peer.close();
    }
  }
  return { WebSocket: FakeWs as unknown as typeof WebSocket, peers };
}

// ---- fetch ---------------------------------------------------------------------

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  form?: FormData;
}

/** A fetch for DriverDeps.fetch. `route` returns [status, body] or "hang" (waits for the abort signal). */
export function fakeFetch(route: (c: FetchCall) => [number, unknown] | "hang" | Promise<[number, unknown]>) {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = { url: String(input), method: init.method ?? "GET", headers };
    if (typeof init.body === "string") call.json = JSON.parse(init.body);
    if (init.body instanceof FormData) call.form = init.body;
    calls.push(call);
    const r = route(call);
    if (r === "hang") {
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      });
    }
    const [status, body] = await r;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
