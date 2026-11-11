// Morphix Cloud link (device side) against a fake cloud that speaks the Morfix-sever API.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudLink, type CloudReport } from "../apps/server/src/cloud";

class FakeCloud {
  devices = new Map<string, { secret: string; code: string; status: "pending" | "paired" | "revoked"; name: string; reports: unknown[] }>();
  requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  down = false;
  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method: init?.method ?? "GET", path: url.pathname, auth, body });
    const reply = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "Content-Type": "application/json" } });
    const who = () => {
      const m = /^Bearer (.+)\.(.+)$/.exec(auth ?? "");
      const d = m ? this.devices.get(m[1]) : undefined;
      return d && d.secret === m![2] ? d : null;
    };
    if (url.pathname === "/api/devices/pairing" && init?.method === "POST") {
      const id = `00000000-0000-4000-8000-${String(this.devices.size + 1).padStart(12, "0")}`;
      const secret = "s".repeat(43);
      this.devices.set(id, { secret, code: "ABCD-2345", status: "pending", name: body.name, reports: [] });
      return reply(201, { deviceId: id, secret, code: "ABCD-2345", pairUrl: "https://cloud.test/pair?code=ABCD-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if (url.pathname === "/api/devices/pairing") {
      const d = who();
      return d ? reply(200, { status: d.status, name: d.name }) : reply(401, { error: { message: "Unknown device." } });
    }
    if (url.pathname === "/api/devices/heartbeat") {
      const d = who();
      if (!d) return reply(401, {});
      if (d.status === "revoked") return reply(410, { error: { message: "removed" } });
      d.reports.push(body);
      return reply(200, { ok: true });
    }
    return reply(404, {});
  };
  claimAll() {
    for (const d of this.devices.values()) d.status = "paired";
  }
}

let dir = "";
const links: CloudLink[] = [];
afterEach(() => {
  links.forEach((l) => l.stop());
  links.length = 0;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const report: CloudReport = { online: true, state: "printing", printer: "Afinia QD330", file: "cube.gx", progress: 42, nozzleC: 210, bedC: 60 };
function link(cloud: FakeCloud, extra: Partial<ConstructorParameters<typeof CloudLink>[0]> = {}) {
  const l = new CloudLink({ dataDir: dir, url: "https://cloud.test/", version: "0.2.0", name: () => "Lab QD330", report: () => report, fetch: cloud.fetch, pollMs: 10, heartbeatMs: 60_000, ...extra });
  links.push(l);
  return l;
}
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  return fn();
};

describe("Morphix Cloud link", () => {
  it("pairs with a code + QR, keeps the secret private, and reports status", async () => {
    dir = mkdtempSync(join(tmpdir(), "morphix-cloud-"));
    const cloud = new FakeCloud();
    const l = link(cloud);
    expect(l.status()).toMatchObject({ state: "off", url: "https://cloud.test" });

    const s = await l.pair();
    expect(s).toMatchObject({ state: "pairing", code: "ABCD-2345", pairUrl: "https://cloud.test/pair?code=ABCD-2345" });
    expect(s.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(s)).not.toContain("sss"); // no secret in what the UI sees
    expect(cloud.requests[0].body).toEqual({ name: "Lab QD330", version: "0.2.0" });

    cloud.claimAll();
    expect(await until(() => l.status().state === "paired")).toBe(true);
    expect(l.status()).toMatchObject({ state: "paired", name: "Lab QD330" });
    expect(JSON.stringify(l.status())).not.toContain("sss");

    // Saved with mode 0600, and the first report went out.
    const file = join(dir, "cloud.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const dev = [...cloud.devices.values()][0];
    expect(await until(() => dev.reports.length === 1)).toBe(true);
    expect(dev.reports[0]).toEqual({ ...report, version: "0.2.0" });
    expect(cloud.requests.filter((r) => r.path === "/api/devices/heartbeat").every((r) => r.auth?.startsWith("Bearer 00000000-"))).toBe(true);
  });

  it("stays paired across restarts, and forgets the link when the dashboard removes it", async () => {
    dir = mkdtempSync(join(tmpdir(), "morphix-cloud-"));
    const cloud = new FakeCloud();
    const a = link(cloud);
    await a.pair();
    cloud.claimAll();
    expect(await until(() => a.status().state === "paired")).toBe(true);
    a.stop();

    const b = link(cloud); // a restart
    expect(b.status().state).toBe("paired");
    [...cloud.devices.values()][0].status = "revoked";
    await b.heartbeat();
    expect(b.status()).toMatchObject({ state: "off", error: expect.stringMatching(/removed from Morphix Cloud/) });
    expect(existsSync(join(dir, "cloud.json"))).toBe(false);
  });

  it("ignores a saved link for a different cloud address", async () => {
    dir = mkdtempSync(join(tmpdir(), "morphix-cloud-"));
    const cloud = new FakeCloud();
    const a = link(cloud);
    await a.pair();
    cloud.claimAll();
    expect(await until(() => a.status().state === "paired")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "cloud.json"), "utf8")).url).toBe("https://cloud.test");
    expect(link(cloud, { url: "https://other.example" }).status().state).toBe("off");
  });

  it("explains a cloud that can't be reached, and lets you cancel", async () => {
    dir = mkdtempSync(join(tmpdir(), "morphix-cloud-"));
    const cloud = new FakeCloud();
    cloud.down = true;
    const l = link(cloud);
    expect(await l.pair()).toMatchObject({ state: "off", error: expect.stringMatching(/Couldn't start pairing.*Check this machine is online/) });
    cloud.down = false;
    expect((await l.pair()).state).toBe("pairing");
    expect(l.unpair().state).toBe("off");
  });
});
