// Static files: the built UI (single-page app) and the model library, with path traversal,
// encoded tricks and symlinks that point out of the root all refused.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPath, libraryFile, safeResolve } from "../apps/server/src/static";
import { startTestServer, type TestServer } from "./server-helpers";

let dir = "";
let ui = "";
let data = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "morphix-static-"));
  ui = join(dir, "renderer");
  data = join(dir, "data");
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Morphix</title>");
  writeFileSync(join(ui, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(ui, "pcm-recorder.worklet.js"), "//");
  mkdirSync(join(data, "models", "p1"), { recursive: true });
  mkdirSync(join(data, "config"), { recursive: true });
  writeFileSync(join(data, "models", "p1", "model.stl"), "solid x");
  writeFileSync(join(data, "config", "morphix.env"), "GEMINI_API_KEY=secret");
  writeFileSync(join(dir, "outside.txt"), "outside");
  symlinkSync(join(dir, "outside.txt"), join(ui, "assets", "escape.js"));
  symlinkSync(join(data, "config"), join(data, "models", "p1", "cfg"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let s: TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

/** Raw request so the path is sent exactly as written (fetch would normalise "..") */
function rawGet(port: string, path: string, cookie = ""): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: Number(port), path, method: "GET", headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("path helpers", () => {
  it("cleanPath refuses dot segments, NUL, backslashes and bad encodings", () => {
    expect(cleanPath("/assets/a.js?x=1")).toBe("/assets/a.js");
    expect(cleanPath("/a%20b")).toBe("/a b");
    for (const bad of ["/../etc/passwd", "/a/%2e%2e/b", "/%2e%2e%2fetc", "/a\\b", "/a%5c..%5cb", "/x%00", "//evil", "/%E0%A4%A"]) expect(cleanPath(bad)).toBeNull();
  });
  it("safeResolve stays inside the root, even through symlinks", () => {
    expect(safeResolve(ui, "index.html")).toBe(join(ui, "index.html"));
    expect(safeResolve(ui, "../outside.txt")).toBeNull();
    expect(safeResolve(ui, "assets/escape.js")).toBeNull();
    expect(safeResolve(ui, "assets")).toBeNull(); // folders are not files
  });
  it("libraryFile only serves the library folders", () => {
    expect(libraryFile(data, "/library/models/p1/model.stl")).toBe(join(data, "models", "p1", "model.stl"));
    expect(libraryFile(data, "/library/config/morphix.env")).toBeNull();
    expect(libraryFile(data, "/library/models/p1/cfg/morphix.env")).toBeNull();
    expect(libraryFile(data, "/library/models/../config/morphix.env")).toBeNull();
  });
});

describe("serving", () => {
  it("serves the UI, falls back to index.html for app pages, 404s missing assets", async () => {
    s = await startTestServer({ rendererDir: ui, storageRoot: data });
    const c = s.client();
    const index = await c.fetch("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>Morphix</title>");
    expect(index.headers.getSetCookie().some((x) => x.startsWith("morphix_csrf="))).toBe(true);
    const js = await c.fetch("/assets/app-abc.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toMatch(/immutable/);
    expect((await c.fetch("/settings")).status).toBe(200);
    expect((await c.fetch("/assets/missing.js")).status).toBe(404);
    expect((await c.fetch("/", { method: "POST", csrf: false })).status).toBe(405);
  });

  it("refuses traversal in every spelling", async () => {
    s = await startTestServer({ rendererDir: ui, storageRoot: data });
    const port = s.host.split(":")[1];
    for (const p of ["/../outside.txt", "/assets/../../outside.txt", "/%2e%2e/outside.txt", "/assets/%2e%2e%2f%2e%2e%2foutside.txt", "/..%5coutside.txt", "/assets/escape.js"]) {
      const r = await rawGet(port, p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).not.toContain("outside");
    }
  });

  it("serves library files only to signed-in users and never the key file", async () => {
    s = await startTestServer({ rendererDir: ui, storageRoot: data });
    const port = s.host.split(":")[1];
    expect((await s.client().fetch("/library/models/p1/model.stl")).status).toBe(401);
    const r = await s.client("tok-user").fetch("/library/models/p1/model.stl");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("model/stl");
    for (const p of ["/library/config/morphix.env", "/library/models/../config/morphix.env", "/library/models/%2e%2e/config/morphix.env", "/library/models/p1/cfg/morphix.env"]) {
      const x = await rawGet(port, p, "mx_test=tok-user");
      expect(x.status, p).toBe(404);
      expect(x.body).not.toContain("secret");
    }
  });

  it("says plainly when the UI isn't built", async () => {
    s = await startTestServer({ rendererDir: join(dir, "nope") });
    const r = await s.client().fetch("/");
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/npm run build:renderer/);
  });
});
