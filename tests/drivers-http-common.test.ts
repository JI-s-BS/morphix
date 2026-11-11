// Shared parts of the "http" driver family: address parsing, file names, HTTP Digest (RFC vectors),
// mDNS discovery (against a local fake responder) and the registry.
import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { DRIVERS, getDriver } from "../packages/printer/src/drivers/registry";
import { DriverError } from "../packages/printer/src/drivers/types";
import { HTTP_DRIVERS } from "../packages/printer/src/drivers/http";
import { absoluteUrl, baseUrl, safeFileName } from "../packages/printer/src/drivers/http/common";
import { digestHeader, digestResponse, parseDigestChallenge } from "../packages/printer/src/drivers/http/digest";
import { buildQuery, collectServices, parseRecords } from "../packages/printer/src/drivers/http/mdns";
import { discoverMoonraker } from "../packages/printer/src/drivers/http/moonraker";

describe("http drivers: registry", () => {
  it("registers moonraker, octoprint, prusalink and duet with help text on every field", () => {
    expect(HTTP_DRIVERS.map((d) => d.id)).toEqual(["moonraker", "octoprint", "prusalink", "duet"]);
    for (const d of HTTP_DRIVERS) {
      expect(getDriver(d.id)).toBe(d);
      expect(DRIVERS).toContain(d);
      expect(d.fields.find((f) => f.key === "host")?.required).toBe(true);
      for (const f of d.fields) expect(f.help, `${d.id}.${f.key}`).toMatch(/\w{3,}/);
    }
  });
});

describe("http drivers: addresses", () => {
  it("builds base URLs from host + port", () => {
    expect(baseUrl({ host: "192.168.1.5" }, 7125)).toBe("http://192.168.1.5:7125");
    expect(baseUrl({ host: "192.168.1.5", port: 80 }, 7125)).toBe("http://192.168.1.5");
    expect(baseUrl({ host: "voron.local:7125", port: 80 })).toBe("http://voron.local:7125");
    expect(baseUrl({ host: "https://printer.lan/" })).toBe("https://printer.lan");
    expect(baseUrl({ host: "fe80::1" }, 80)).toBe("http://[fe80::1]");
    expect(baseUrl({ host: " octopi.local " })).toBe("http://octopi.local");
  });

  it("rejects empty, odd schemes and embedded logins", () => {
    for (const host of ["", "ftp://x", "http://user:pw@x", "http://x/?apikey=1"]) {
      expect(() => baseUrl({ host })).toThrow(DriverError);
    }
    try {
      baseUrl({ host: "http://user:secret@x" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret");
    }
  });

  it("makes camera URLs absolute and swaps localhost for the printer", () => {
    expect(absoluteUrl("/webcam/?action=stream", "http://10.0.0.2:7125", true)).toBe("http://10.0.0.2/webcam/?action=stream");
    expect(absoluteUrl("http://127.0.0.1:8080/?action=snapshot", "http://octopi.local")).toBe("http://octopi.local:8080/?action=snapshot");
    expect(absoluteUrl("javascript:alert(1)", "http://x")).toBeUndefined();
  });

  it("makes safe file names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd.gcode");
    expect(safeFileName("Benchy (PLA).gcode")).toBe("Benchy _PLA_.gcode");
    expect(safeFileName('a"b.gcode')).toBe("a_b.gcode");
    expect(safeFileName(".hidden.gcode")).toBe("hidden.gcode");
    expect(safeFileName("x".repeat(300) + ".gcode").length).toBeLessThanOrEqual(96);
  });
});

describe("http drivers: HTTP Digest (RFC vectors)", () => {
  it("RFC 2617 §3.5 example (MD5, qop=auth)", () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    expect(challenge.realm).toBe("testrealm@host.com");
    const input = { username: "Mufasa", password: "Circle Of Life", method: "GET", uri: "/dir/index.html", challenge, nc: "00000001", cnonce: "0a4f113b" };
    expect(digestResponse(input)).toBe("6629fae49393a05397450978507c4ef1");
    const header = digestHeader(input);
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(header).toContain("qop=auth, nc=00000001");
    expect(header).not.toContain("Circle");
  });

  it("RFC 7616 §3.9.1 example (MD5 and SHA-256)", () => {
    const base = 'Digest realm="http-auth@example.org", qop="auth, auth-int", nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
    const common = { username: "Mufasa", password: "Circle of Life", method: "GET", uri: "/dir/index.html", nc: "00000001", cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ" };
    expect(digestResponse({ ...common, challenge: parseDigestChallenge(`${base}, algorithm=MD5`)! })).toBe("8ca523f5e9506fed4657c9700eebdbec");
    expect(digestResponse({ ...common, challenge: parseDigestChallenge(`${base}, algorithm=SHA-256`)! })).toBe("753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1");
  });

  it("falls back to RFC 2069 without qop and ignores non-Digest challenges", () => {
    const c = parseDigestChallenge('Digest realm="Printer API", nonce="abc", stale=true')!;
    expect(c.qop).toBeUndefined();
    expect(c.stale).toBe(true);
    expect(digestHeader({ username: "maker", password: "pw", method: "GET", uri: "/api/v1/status", challenge: c, nc: "00000001", cnonce: "x" })).not.toContain("qop=");
    expect(parseDigestChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseDigestChallenge(null)).toBeUndefined();
  });
});

/** Encodes a DNS-SD answer: PTR + SRV + TXT + A, using name compression for the service name. */
function mdnsAnswer(instance: string, service: string, host: string, ip: string, port: number): Buffer {
  const name = (n: string) => Buffer.concat([...n.split(".").map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
  const rr = (owner: Buffer, type: number, data: Buffer) => {
    const h = Buffer.alloc(10);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(1, 2);
    h.writeUInt32BE(120, 4);
    h.writeUInt16BE(data.length, 8);
    return Buffer.concat([owner, h, data]);
  };
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(3, 10);
  const svcName = name(service); // at offset 12
  const ptrPtr = Buffer.from([0xc0, 12]);
  const instLabel = Buffer.from(instance);
  const ptrData = Buffer.concat([Buffer.from([instLabel.length]), instLabel, ptrPtr]);
  const ptr = rr(svcName, 12, ptrData);
  const instFull = name(`${instance}.${service}`);
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 255]), name(host)]);
  const txtEntry = Buffer.from("version=v0.9.3");
  const txt = rr(instFull, 16, Buffer.concat([Buffer.from([txtEntry.length]), txtEntry]));
  const a = rr(name(host), 1, Buffer.from(ip.split(".").map(Number)));
  return Buffer.concat([header, ptr, rr(instFull, 33, srvData), txt, a]);
}

describe("http drivers: mDNS discovery", () => {
  it("builds a PTR query and parses a compressed DNS-SD answer", () => {
    const q = buildQuery("_moonraker._tcp.local");
    expect(q.readUInt16BE(4)).toBe(1);
    expect(q.subarray(12).toString("latin1")).toContain("_moonraker");
    const msg = mdnsAnswer("Voron 2.4", "_moonraker._tcp.local", "voron.local", "192.168.1.50", 7125);
    expect(parseRecords(msg).map((r) => r.type)).toEqual([12, 33, 16, 1]);
    expect(collectServices([msg], "_moonraker._tcp.local")).toEqual([
      { instance: "Voron 2.4", host: "voron.local", port: 7125, address: "192.168.1.50", txt: { version: "v0.9.3" } },
    ]);
    expect(collectServices([Buffer.from([1, 2, 3])], "_moonraker._tcp.local")).toEqual([]);
  });

  it("discovers Moonraker from a fake responder", async () => {
    const responder = createSocket("udp4");
    responder.on("message", (msg, rinfo) => {
      if (msg.toString("latin1").includes("_moonraker")) responder.send(mdnsAnswer("SV08", "_moonraker._tcp.local", "sv08.local", "10.0.0.8", 7125), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => responder.bind(0, "127.0.0.1", r));
    const found = await discoverMoonraker(300, { address: "127.0.0.1", port: responder.address().port });
    responder.close();
    expect(found).toEqual([{ driver: "moonraker", host: "10.0.0.8", port: 7125, name: "SV08" }]);
  });

  it("returns nothing (and does not throw) when nobody answers", async () => {
    const found = await discoverMoonraker(100, { address: "127.0.0.1", port: 9 });
    expect(found).toEqual([]);
  });
});
