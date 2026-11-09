import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPath, parsePrinterCommand, safeResolve } from "@morphix/portal";
import { Client, signIn, startHarness, type Harness } from "./portal-helpers";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);

/** Raw request so the path is sent exactly as written (fetch would normalise "..", "%2e%2e"). */
function rawGet(base: string, path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}Connection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d.toString("latin1")));
    sock.on("end", () => resolve({ status: Number(data.split(" ")[1]), body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n") }));
    sock.on("error", reject);
  });
}

/** Read Server-Sent Events until `until` returns true. */
async function readEvents(res: Response, until: (events: any[]) => boolean, timeoutMs = 3000): Promise<any[]> {
  const reader = res.body!.getReader();
  const events: any[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString();
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (block.includes("event: job") && data) events.push(JSON.parse(data.slice(6)));
      if (block.startsWith(": ping")) events.push({ ping: true });
    }
    if (until(events)) break;
  }
  await reader.cancel();
  return events;
}

describe("portal API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ allowed: ["kid@example.com"], admins: ["parent@example.com"] });
  });
  afterEach(async () => h.close());

  it("sets security headers on every response", async () => {
    for (const path of ["/", "/api/me", "/static/app.js", "/nope"]) {
      const res = await fetch(h.base + path);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/); // only the import map is allowed inline
      expect(csp).not.toContain("unsafe-inline");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
    }
  });

  it("serves the front-end and three.js without login, but no data", async () => {
    expect((await fetch(h.base + "/")).headers.get("content-type")).toMatch(/text\/html/);
    const three = await fetch(h.base + "/vendor/three/three.module.js");
    expect(three.status).toBe(200);
    expect(three.headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(h.base + "/vendor/three-addons/controls/OrbitControls.js")).status).toBe(200);
    expect((await fetch(h.base + "/vendor/three/package.json")).status).toBe(404);
    expect((await fetch(h.base + "/vendor/three-addons/../../package.json")).status).toBe(404);
    for (const path of ["/api/me", "/api/projects", "/api/actions", "/api/printer", "/api/jobs/j1/events", "/api/models/v1"]) {
      const res = await fetch(h.base + path);
      expect(res.status, path).toBe(401);
      expect((await res.json()).error).toBe("login_required");
    }
  });

  it("lists projects and serves model files for the viewer", async () => {
    const { client } = await signIn(h);
    const { projects } = await (await client.req("/api/projects")).json();
    expect(projects).toHaveLength(1);
    const { project } = await (await client.req(`/api/projects/${projects[0].id}`)).json();
    expect(project.versions[0].format).toBe("stl");
    const model = await client.req(`/api/models/${project.latestVersionId}`);
    expect(model.status).toBe(200);
    expect(model.headers.get("content-type")).toBe("model/stl");
    expect(await model.text()).toMatch(/^solid cube/);
    expect((await client.req("/api/projects/nope")).status).toBe(404);
  });

  describe("CSRF", () => {
    it("requires the CSRF token on every state-changing request", async () => {
      const { client, csrf } = await signIn(h);
      const post = (headers: Record<string, string>) =>
        client.req("/api/text-requests", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ prompt: "a boat" }) });
      expect((await post({})).status).toBe(403);
      expect((await post({ "x-csrf-token": "wrong" })).status).toBe(403);
      expect((await post({ "x-csrf-token": csrf, origin: "https://evil.example.com" })).status).toBe(403);
      expect((await post({ "x-csrf-token": csrf, "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect(h.backend.textRequests).toHaveLength(0);
      const ok = await post({ "x-csrf-token": csrf, origin: h.base, "sec-fetch-site": "same-origin" });
      expect(ok.status).toBe(202);
      expect((await ok.json()).jobId).toBeTruthy();
      expect(h.backend.textRequests.map((r) => r.prompt)).toEqual(["a boat"]);
    });

    it("does not accept another user's CSRF token", async () => {
      const a = await signIn(h);
      const b = await signIn(h);
      const res = await a.client.req("/api/text-requests", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": b.csrf }, body: "{}" });
      expect(res.status).toBe(403);
    });

    it("protects uploads and confirmations too", async () => {
      const { client } = await signIn(h);
      const form = new FormData();
      form.append("images", new Blob([JPEG]), "a.jpg");
      expect((await client.req("/api/requests", { method: "POST", body: form })).status).toBe(403);
      expect((await client.req("/api/actions/a1/confirm", { method: "POST" })).status).toBe(403);
      expect((await client.req("/api/printer/command", { method: "POST" })).status).toBe(403);
      expect(h.backend.photoRequests).toHaveLength(0);
    });
  });

  it("accepts a photo upload end-to-end and hands it to the backend", async () => {
    const { client, csrf } = await signIn(h);
    const form = new FormData();
    form.append("images", new Blob([JPEG], { type: "image/jpeg" }), "toy.jpg");
    form.append("scan", new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"]), "toy.obj");
    form.append("description", "my toy, but bigger");
    form.append("referenceObject", "coin");
    form.append("measurements", JSON.stringify([{ label: "Height", value: 4, unit: "cm" }]));
    const res = await client.req("/api/requests", { method: "POST", headers: { "x-csrf-token": csrf }, body: form });
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBeTruthy();
    const req = h.backend.photoRequests[0];
    expect(req.user.email).toBe("kid@example.com");
    expect(req.images[0]).toMatchObject({ name: "toy.jpg", mime: "image/jpeg" });
    expect(req.scan).toMatchObject({ format: "obj" });
    expect(req.referenceObject).toBe("coin");
    expect(req.measurements).toEqual([{ label: "Height", value: 4, unit: "cm" }]);
  });

  it("returns friendly upload errors", async () => {
    const { client, csrf } = await signIn(h);
    const form = new FormData();
    form.append("images", new Blob(["GIF89a not allowed"]), "x.gif");
    const res = await client.req("/api/requests", { method: "POST", headers: { "x-csrf-token": csrf }, body: form });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: "bad_image" });
    const text = await client.req("/api/text-requests", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: "x".repeat(1001) }) });
    expect(text.status).toBe(400);
  });

  it("refuses oversized uploads from Content-Length before reading them", async () => {
    const { client, csrf } = await signIn(h);
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(h.base);
      const req = request({
        host: u.hostname,
        port: u.port,
        path: "/api/requests",
        method: "POST",
        headers: {
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          "x-csrf-token": csrf,
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(500 * 1024 * 1024),
        },
      });
      req.on("response", (res) => {
        resolve(res.statusCode!);
        res.resume();
        req.destroy();
      });
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it("rate-limits uploads per user", async () => {
    await h.close();
    h = await startHarness({ limits: { uploadsPer10Min: 2 } });
    const { client, csrf } = await signIn(h);
    const send = () => client.req("/api/text-requests", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: "a cat" }) });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
  });

  describe("admin gating", () => {
    const cmd = (c: Client, csrf: string, body: unknown) =>
      c.req("/api/printer/command", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });

    it("blocks printer commands for non-admins", async () => {
      const { client, csrf } = await signIn(h, "kid@example.com");
      const res = await cmd(client, csrf, { cmd: "light", args: { on: false } });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("admins_only");
      expect(h.backend.commands).toHaveLength(0);
      // Status and camera are fine for everyone signed in.
      expect((await client.req("/api/printer")).status).toBe(200);
    });

    it("lets admins send validated commands", async () => {
      const { client, csrf } = await signIn(h, "parent@example.com");
      const res = await cmd(client, csrf, { cmd: "pause" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await cmd(client, csrf, { cmd: "rm -rf /" })).status).toBe(400);
      expect((await cmd(client, csrf, { cmd: "temperature", args: { heater: "nozzle", celsius: 999 } })).status).toBe(400);
      expect((await cmd(client, csrf, { cmd: "fan", args: { speed: "100; G28" } })).status).toBe(400);
      expect(h.backend.commands.map((c) => c.command.cmd)).toEqual(["pause"]);
    });

    it("validates command arguments strictly", () => {
      expect(parsePrinterCommand({ cmd: "light", args: { on: true } })).toEqual({ cmd: "light", args: { on: true } });
      expect(parsePrinterCommand({ cmd: "light", args: { on: "yes" } })).toBeNull();
      expect(parsePrinterCommand({ cmd: "fan", args: { speed: 101 } })).toBeNull();
      expect(parsePrinterCommand({ cmd: "temperature", args: { heater: "bed", celsius: 60 } })).toEqual({ cmd: "temperature", args: { heater: "bed", celsius: 60 } });
      expect(parsePrinterCommand({ cmd: "temperature", args: { heater: "bed", celsius: 120 } })).toBeNull();
      expect(parsePrinterCommand({ cmd: "home", args: { extra: "M112" } })).toEqual({ cmd: "home", args: {} });
      expect(parsePrinterCommand(null)).toBeNull();
    });

    it("only lets admins confirm print actions; anyone allowed can confirm generation costs", async () => {
      h.backend.actions.set("print1", { id: "print1", jobId: "none", kind: "print", title: "Print it?", details: [], createdAt: new Date().toISOString() });
      const kid = await signIn(h, "kid@example.com");
      const confirm = (c: Client, csrf: string, id: string) => c.req(`/api/actions/${id}/confirm`, { method: "POST", headers: { "x-csrf-token": csrf } });
      expect((await confirm(kid.client, kid.csrf, "print1")).status).toBe(403);
      expect(h.backend.actions.has("print1")).toBe(true);
      const parent = await signIn(h, "parent@example.com");
      expect((await confirm(parent.client, parent.csrf, "print1")).status).toBe(200);
      expect(h.backend.actions.has("print1")).toBe(false);
      expect((await confirm(kid.client, kid.csrf, "print1")).status).toBe(404);
    });
  });

  describe("job progress (SSE)", () => {
    it("streams stages, the cost question and the finished job", async () => {
      const { client, csrf } = await signIn(h);
      const { jobId } = await (
        await client.req("/api/text-requests", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: "a rocket" }) })
      ).json();
      const res = await client.req(`/api/jobs/${jobId}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const timer = setInterval(() => h.backend.advanceAll(), 20);
      const events = await readEvents(res, (ev) => ev.some((e) => e.status === "waiting"));
      clearInterval(timer);
      expect(events[0]).toMatchObject({ jobId, status: "running" });
      const waiting = events.find((e) => e.status === "waiting");
      expect(waiting.actionId).toBeTruthy();
      expect(waiting.stages.map((s: any) => s.state)).toEqual(["done", "done", "active", "pending", "pending"]);

      const { actions } = await (await client.req("/api/actions")).json();
      expect(actions[0]).toMatchObject({ id: waiting.actionId, kind: "generate", credits: 20 });
      expect((await client.req(`/api/actions/${waiting.actionId}/confirm`, { method: "POST", headers: { "x-csrf-token": csrf } })).status).toBe(200);

      const res2 = await client.req(`/api/jobs/${jobId}/events`);
      const t2 = setInterval(() => h.backend.advanceAll(), 20);
      const done = await readEvents(res2, (ev) => ev.some((e) => e.status === "succeeded"));
      clearInterval(t2);
      expect(done.at(-1)).toMatchObject({ status: "succeeded", progress: 100 });
      expect(done.at(-1).projectId).toBeTruthy();
    });

    it("sends error codes with a hint when a job fails", async () => {
      await h.close();
      h = await startHarness({ confirmCost: false });
      const { client, csrf } = await signIn(h);
      const { jobId } = await (
        await client.req("/api/text-requests", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ prompt: "please fail" }) })
      ).json();
      const res = await client.req(`/api/jobs/${jobId}/events`);
      const t = setInterval(() => h.backend.advanceAll(), 20);
      const events = await readEvents(res, (ev) => ev.some((e) => e.status === "failed"));
      clearInterval(t);
      const failed = events.find((e) => e.status === "failed");
      expect(failed.error.code).toMatch(/^MX-[A-Z]+-\d{3}$/);
      expect(failed.error.hint).toBeTruthy();
    });

    it("sends heartbeats, 404s unknown jobs and unsubscribes when the browser leaves", async () => {
      const { client } = await signIn(h);
      expect((await client.req("/api/jobs/unknown/events")).status).toBe(404);
      expect((await client.req("/api/jobs/..%2f..%2fetc/events")).status).toBe(400); // rejected by cleanPath
      const { jobId } = await h.backend.createTextRequest("a fish", { sub: "x", email: "kid@example.com", name: "kid", isAdmin: false });
      const job = h.backend.jobs.get(jobId)!;
      const res = await client.req(`/api/jobs/${jobId}/events`);
      const events = await readEvents(res, (ev) => ev.some((e) => e.ping));
      expect(events.some((e) => e.ping)).toBe(true);
      // reader.cancel() closed the connection
      await new Promise((r) => setTimeout(r, 100));
      expect(job.listeners.size).toBe(0);
    });
  });

  describe("camera proxy", () => {
    it("requires login", async () => {
      const res = await fetch(h.base + "/api/camera");
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toMatch(/json/);
    });

    it("streams MJPEG to signed-in users and closes the upstream when they leave", async () => {
      const { client } = await signIn(h);
      let upstreamClosed = false;
      const original = h.backend.cameraStream.bind(h.backend);
      h.backend.cameraStream = async () => {
        const cam = (await original())!;
        cam.stream.on("close", () => (upstreamClosed = true));
        return cam;
      };
      const res = await client.req("/api/camera");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^multipart\/x-mixed-replace/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(Buffer.from(value!).toString("latin1")).toContain("Content-Type: image/jpeg");
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 100));
      expect(upstreamClosed).toBe(true);
    });

    it("limits concurrent viewers and reports a missing camera", async () => {
      const { client } = await signIn(h);
      const open = [await client.req("/api/camera"), await client.req("/api/camera"), await client.req("/api/camera")];
      expect(open.map((r) => r.status)).toEqual([200, 200, 200]);
      expect((await client.req("/api/camera")).status).toBe(503);
      for (const r of open) await r.body!.cancel();
      await new Promise((r) => setTimeout(r, 100));
      h.backend.cameraEnabled = false;
      const res = await client.req("/api/camera");
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("camera_unavailable");
    });
  });

  describe("path traversal", () => {
    it("refuses climbing out of the static folders", async () => {
      for (const path of [
        "/static/../../../package.json",
        "/static/%2e%2e/%2e%2e/%2e%2e/package.json",
        "/static/..%2f..%2f..%2fpackage.json",
        "/static/%2e%2e%5c%2e%2e%5cpackage.json",
        "/static/app.js%00.css",
        "/vendor/three-addons/../../../../package.json",
        "/vendor/three-addons/..%2f..%2f..%2fpackage.json",
        "//etc/passwd",
      ]) {
        const res = await rawGet(h.base, path);
        expect([400, 404], path).toContain(res.status);
        expect(res.body, path).not.toContain('"name": "morphix"');
      }
      expect((await rawGet(h.base, "/static/app.js")).status).toBe(200);
    });

    it("refuses model files outside the storage root, even if the backend points there", async () => {
      const { client } = await signIn(h);
      const outside = mkdtempSync(join(tmpdir(), "outside-"));
      writeFileSync(join(outside, "secret.stl"), "solid secret");
      h.backend.files.set("evil1", { path: join(outside, "secret.stl"), format: "stl" });
      h.backend.files.set("evil2", { path: join(h.storageRoot, "..", outside.split("/").pop()!, "secret.stl"), format: "stl" });
      symlinkSync(join(outside, "secret.stl"), join(h.storageRoot, "link.stl"));
      h.backend.files.set("evil3", { path: join(h.storageRoot, "link.stl"), format: "stl" });
      writeFileSync(join(h.storageRoot, "morphix.env.stl"), "solid x");
      h.backend.files.set("evil4", { path: join(h.storageRoot, "morphix.env.stl"), format: "glb" }); // wrong extension
      for (const id of ["evil1", "evil2", "evil3", "evil4"]) expect((await client.req(`/api/models/${id}`)).status, id).toBe(404);
      expect((await rawGet(h.base, "/api/models/..%2f..%2fetc%2fpasswd", [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "))).status).toBe(400);
    });

    it("cleanPath and safeResolve reject traversal", () => {
      expect(cleanPath("/a/../b")).toBeNull();
      expect(cleanPath("/a/%2e%2e/b")).toBeNull();
      expect(cleanPath("/a%00b")).toBeNull();
      expect(cleanPath("/a%5cb")).toBeNull();
      expect(cleanPath("/%E0%A4%A")).toBeNull();
      expect(cleanPath("http://evil/")).toBeNull();
      expect(cleanPath("/api/projects?x=1")!.path).toBe("/api/projects");
      const root = mkdtempSync(join(tmpdir(), "root-"));
      writeFileSync(join(root, "ok.txt"), "ok");
      expect(safeResolve(root, "ok.txt")).toBe(join(root, "ok.txt"));
      expect(safeResolve(root, "../etc/passwd")).toBeNull();
      expect(safeResolve(root, "/etc/passwd")).toBe(null);
    });
  });

  it("rejects wrong methods and unknown routes", async () => {
    const { client, csrf } = await signIn(h);
    expect((await client.req("/api/projects", { method: "POST", headers: { "x-csrf-token": csrf } })).status).toBe(405);
    expect((await client.req("/api/requests")).status).toBe(405);
    expect((await client.req("/api/whatever")).status).toBe(404);
  });

  it("hides internal errors", async () => {
    const { client } = await signIn(h);
    h.backend.listProjects = async () => {
      throw new Error("SQLITE_CORRUPT at /home/jd/Morphix/morphix.db");
    };
    const res = await client.req("/api/projects");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("/home/jd");
  });
});
