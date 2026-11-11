// Minimal mDNS / DNS-SD browser with node:dgram (RFC 6762 / 6763): sends one PTR query for a service type
// such as "_moonraker._tcp.local" from an ephemeral port ("legacy unicast", RFC 6762 §6.7: responders answer
// straight back to that port) and collects PTR → SRV → A/AAAA answers. Tested against a local fake responder,
// not against real printers. No multicast group join, so it needs no special permissions.
import { createSocket } from "node:dgram";

export interface MdnsService {
  /** "Voron 2.4._moonraker._tcp.local" → "Voron 2.4" */
  instance: string;
  host?: string;
  address?: string;
  port?: number;
  txt: Record<string, string>;
}

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

export function buildQuery(service: string, id = 0): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const q = Buffer.alloc(4);
  q.writeUInt16BE(TYPE.PTR, 0);
  q.writeUInt16BE(1, 2); // class IN (QU bit not needed: we listen on the source port)
  return Buffer.concat([header, encodeName(service), q]);
}

function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let jumps = 0; jumps < 32; ) {
    if (pos >= buf.length) throw new Error("name out of range");
    const len = buf[pos];
    if (len === 0) {
      pos++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      jumps++;
      continue;
    }
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join("."), end >= 0 ? end : pos];
}

interface Record_ {
  name: string;
  type: number;
  data: Buffer;
  offset: number;
}

/** Parses all answer / authority / additional records of a DNS message. */
export function parseRecords(buf: Buffer): Record_[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;
  const out: Record_[] = [];
  for (let i = 0; i < total && pos < buf.length; i++) {
    const [name, p] = readName(buf, pos);
    const type = buf.readUInt16BE(p);
    const rdlen = buf.readUInt16BE(p + 8);
    const start = p + 10;
    out.push({ name, type, data: buf.subarray(start, start + rdlen), offset: start });
    pos = start + rdlen;
  }
  return out;
}

/** Folds DNS messages into services of the given type. */
export function collectServices(messages: Buffer[], service: string): MdnsService[] {
  const svc = service.toLowerCase().replace(/\.$/, "");
  const ptr = new Set<string>();
  const srv = new Map<string, { host: string; port: number }>();
  const txt = new Map<string, Record<string, string>>();
  const addr = new Map<string, string>();
  for (const msg of messages) {
    let records: Record_[];
    try {
      records = parseRecords(msg);
    } catch {
      continue;
    }
    for (const r of records) {
      try {
        if (r.type === TYPE.PTR && r.name.toLowerCase() === svc) ptr.add(readName(msg, r.offset)[0]);
        else if (r.type === TYPE.SRV) srv.set(r.name.toLowerCase(), { port: r.data.readUInt16BE(4), host: readName(msg, r.offset + 6)[0] });
        else if (r.type === TYPE.A && r.data.length === 4) addr.set(r.name.toLowerCase(), Array.from(r.data).join("."));
        else if (r.type === TYPE.AAAA && r.data.length === 16 && !addr.has(r.name.toLowerCase())) {
          const words: string[] = [];
          for (let i = 0; i < 16; i += 2) words.push(r.data.readUInt16BE(i).toString(16));
          addr.set(r.name.toLowerCase(), words.join(":"));
        } else if (r.type === TYPE.TXT) {
          const map: Record<string, string> = {};
          for (let i = 0; i < r.data.length; ) {
            const len = r.data[i];
            const s = r.data.toString("utf8", i + 1, i + 1 + len);
            const eq = s.indexOf("=");
            if (s) map[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? "" : s.slice(eq + 1);
            i += 1 + len;
          }
          txt.set(r.name.toLowerCase(), map);
        }
      } catch {
        // skip a malformed record
      }
    }
  }
  return [...ptr].map((full) => {
    const s = srv.get(full.toLowerCase());
    const suffix = "." + svc;
    const instance = full.toLowerCase().endsWith(suffix) ? full.slice(0, full.length - suffix.length) : full;
    return {
      instance,
      host: s?.host,
      port: s?.port,
      address: s ? addr.get(s.host.toLowerCase()) : undefined,
      txt: txt.get(full.toLowerCase()) ?? {},
    };
  });
}

export interface BrowseOptions {
  /** Where to send the query; tests point this at a local fake responder. */
  address?: string;
  port?: number;
}

/** Asks the LAN for one service type and returns what answered within `timeoutMs`. Never throws. */
export function browse(service: string, timeoutMs: number, opts: BrowseOptions = {}): Promise<MdnsService[]> {
  return new Promise((resolve) => {
    const messages: Buffer[] = [];
    let sock: ReturnType<typeof createSocket>;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(collectServices(messages, service));
    };
    try {
      sock = createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    sock.on("message", (msg) => messages.push(Buffer.from(msg)));
    sock.on("error", finish);
    sock.bind(0, () => {
      sock.send(buildQuery(service), opts.port ?? 5353, opts.address ?? "224.0.0.251", (err) => {
        if (err) finish();
      });
    });
    setTimeout(finish, Math.max(50, timeoutMs)).unref?.();
  });
}
