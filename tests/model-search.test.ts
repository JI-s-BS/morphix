// Smart Model Search ("open source"), with a fake Thingiverse API only: nothing real is searched
// or downloaded. One search call, then each hit's licence/files/picture in parallel.
import { describe, expect, it } from "vitest";
import { SmartModelSearch, detectLicense, hardwareIn, thingiverseThingId } from "@morphix/model-search";
import { needsRealDesign } from "../apps/desktop/electron/voice";

const TOK = "0123456789abcdef0123456789abcdef"; // a real-looking Thingiverse app token
const page = (html: string) => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const geminiReply = (items: unknown[]) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }] });
const JPEG = () => new Response(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200)]), { status: 200 });

interface FakeThing { id: number; name: string; files: string[]; license?: string; description?: string; delayMs?: number; makes?: number }

/** A fake Thingiverse: /search, /things/:id, /things/:id/files and file downloads. */
function thingiverse(things: FakeThing[], opts: { status?: number } = {}) {
  const calls: string[] = [];
  const auth: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.thingiverse.com")) auth.push(new Headers(init?.headers).get("authorization"));
    if (url.startsWith("https://api.thingiverse.com/search/")) {
      if (opts.status) return new Response("no", { status: opts.status });
      return Response.json({ total: things.length, hits: things.map((t) => ({ id: t.id, name: t.name, public_url: `https://www.thingiverse.com/thing:${t.id}`, thumbnail: `https://cdn.thingiverse.com/${t.id}.jpg`, creator: { name: "Maker" }, like_count: 10, make_count: t.makes ?? 0 })) });
    }
    const m = /things\/(\d+)(\/files)?$/.exec(url);
    if (m) {
      const t = things.find((x) => String(x.id) === m[1])!;
      if (t.delayMs) await new Promise((ok) => setTimeout(ok, t.delayMs));
      if (m[2]) return Response.json(t.files.map((n, i) => ({ id: t.id * 100 + i, name: n, size: 1000, download_url: `https://api.thingiverse.com/files/${t.id * 100 + i}/download` })));
      return Response.json({ name: t.name, license: t.license ?? "Creative Commons - Attribution", creator: { name: "TvMaker" }, description: t.description ?? "" });
    }
    if (url.endsWith(".jpg")) return JPEG();
    if (url.endsWith("/download")) return new Response(Buffer.from("solid x\nendsolid x\n"), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls, auth };
}

describe("SmartModelSearch (Thingiverse)", () => {
  it("finds designs with one Thingiverse search, no AI web search and no GitHub", async () => {
    const tv = thingiverse([
      { id: 1, name: "Fidget spinner", files: ["body.stl"], description: "Uses a <b>608 bearing</b> in the middle.", makes: 120 },
      { id: 2, name: "Spinner caps", files: ["cap.stl", "ring.3mf"] },
      { id: 3, name: "Photo only", files: ["photo.jpg"] }, // nothing to download: not offered
    ]);
    const saved: string[] = [];
    const s = new SmartModelSearch({ thingiverseToken: TOK, fetch: tv.fetch, saveImage: (id) => (saved.push(id), `/library/previews/search-${id}.jpg`), qrFor: async () => "data:image/png;base64,QR" });
    const state = await s.search("fidget spinner");
    expect(state.status).toBe("ready");
    expect(state.results.map((r) => r.thingId)).toEqual(["1", "2"]);
    const [a, b] = state.results;
    expect(a).toMatchObject({ source: "thingiverse", name: "Fidget spinner", download: "thingiverse-api", license: "Creative Commons - Attribution", licenseVerified: true, creator: "TvMaker", nonPrintedParts: ["608 bearing"], printAsIs: false });
    expect(a.evidence).toContain("120 makes");
    expect(a.description).toBe("Uses a 608 bearing in the middle.");
    expect(a.thumbUrl).toBe(`/library/previews/search-${a.id}.jpg`);
    expect(b).toMatchObject({ printAsIs: false, parts: ["cap", "ring"] }); // two parts to put together
    expect(tv.calls.filter((u) => u.includes("/search/"))).toHaveLength(1);
    expect(tv.calls.some((u) => /generativelanguage|github/.test(u))).toBe(false);
    expect(tv.auth.every((h) => h === `Bearer ${TOK}`)).toBe(true);
  });

  it("a single part with no hardware prints as it is", async () => {
    const tv = thingiverse([{ id: 7, name: "Vase", files: ["vase.stl"], description: "Spiral vase mode." }]);
    const state = await new SmartModelSearch({ thingiverseToken: TOK, fetch: tv.fetch }).search("vase");
    expect(state.results[0]).toMatchObject({ printAsIs: true, nonPrintedParts: [] });
  });

  it("shows 4 good designs without waiting for a slow one", async () => {
    const tv = thingiverse([1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `D${id}`, files: ["a.stl"], delayMs: id === 6 ? 400 : 0 })));
    const s = new SmartModelSearch({ thingiverseToken: TOK, fetch: tv.fetch });
    const t0 = Date.now();
    const state = await s.search("thing");
    expect(state.results.map((r) => r.thingId)).toEqual(["1", "2", "3", "4"]);
    expect(Date.now() - t0).toBeLessThan(350); // didn't wait for #6
    expect(s.timing).toMatchObject({ searchMs: expect.any(Number), detailsMs: expect.any(Number) });
  });

  it("with a wrong token: says so without Gemini, falls back to Gemini with it; junk isn't a token", async () => {
    const bad = thingiverse([], { status: 401 });
    expect(await new SmartModelSearch({ thingiverseToken: TOK, fetch: bad.fetch }).search("x")).toMatchObject({ status: "failed", error: expect.stringMatching(/didn't accept the app token/) });

    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/search/")) return new Response("no", { status: 401 });
      if (url.includes("generativelanguage")) return geminiReply([{ pageUrl: "https://www.thingiverse.com/thing:5" }]);
      if (url.includes("thing:5")) return page('<meta property="og:title" content="Five"><meta property="og:url" content="https://www.thingiverse.com/thing:5">');
      return new Response("", { status: 404 });
    };
    const s = new SmartModelSearch({ apiKey: "key", thingiverseToken: TOK, fetch });
    expect((await s.search("five")).results.map((r) => r.thingId)).toEqual(["5"]);
    expect(s.tokenRejected).toBe(true);

    const junk = new SmartModelSearch({ apiKey: "key", thingiverseToken: "clear; T=$(mktemp -d); curl -s https://x", fetch });
    expect(junk.thingiverseEnabled).toBe(false); // a command pasted by mistake isn't a token
  });

  it("without a token: Gemini names Thingiverse designs it knows, each page is checked, phone download", async () => {
    const asked: any[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("generativelanguage")) {
        asked.push(JSON.parse(String(init?.body)));
        return geminiReply([
          { pageUrl: "https://www.thingiverse.com/thing:1454048", nonPrintedParts: ["MG90S servos"], parts: ["base", "arm"] },
          { pageUrl: "https://www.thingiverse.com/thing:999999999" }, // made up: page doesn't exist
          { pageUrl: "https://www.thingiverse.com/thing:2104838" }, // made up: Thingiverse shows its generic page (200)
          { pageUrl: "https://github.com/x/y" }, // not Thingiverse: ignored
          { pageUrl: "https://www.thingiverse.com/thing:1717" },
        ]);
      }
      if (url.endsWith("thing:999999999")) return new Response("not found", { status: 404 });
      if (url.endsWith("thing:2104838")) return page('<title>Thingiverse - The community for Open Hardware</title><meta property="og:title" content="Thingiverse - The community for Open Hardware">');
      const id = /thing:(\d+)/.exec(url)?.[1];
      if (id) return page(`<meta property="og:title" content="Robot arm ${id} by Maker"><meta property="og:url" content="https://www.thingiverse.com/thing:${id}"><meta property="og:image" content="https://cdn.thingiverse.com/${id}.jpg"><p>Creative Commons - Attribution</p>`);
      if (url.endsWith(".jpg")) return JPEG();
      return new Response("", { status: 404 });
    };
    const s = new SmartModelSearch({ apiKey: "key", fetch, qrFor: async () => "data:image/png;base64,QR" });
    const state = await s.search("robot arm");
    expect(state.status).toBe("ready");
    expect(state.results.map((r) => r.thingId)).toEqual(["1454048", "1717"]);
    expect(state.results[0]).toMatchObject({ name: "Robot arm 1454048", creator: "Maker", download: "needs-key", licenseVerified: true, nonPrintedParts: ["MG90S servos"], qrDataUrl: "data:image/png;base64,QR" });
    expect(state.more).toBe(true); // shown at once; the web search adds more later
    expect(asked.map((b) => Boolean(b.tools)).sort()).toEqual([false, true]); // both searches started together
    expect(s.timing?.via).toBe("gemini-known");
    await expect(s.download(state.results[0].id)).rejects.toThrow(/on your phone/);
  });

  it("without a token, waits for the web search when Gemini knows none", async () => {
    const asked: any[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("generativelanguage")) {
        const body = JSON.parse(String(init?.body));
        asked.push(body);
        return geminiReply(body.tools ? [{ pageUrl: "https://www.thingiverse.com/thing:22" }, { pageUrl: "https://www.thingiverse.com/thing:33" }] : []);
      }
      const id = /thing:(\d+)/.exec(url)?.[1];
      if (id) return page(`<meta property="og:title" content="Odd gadget ${id}"><meta property="og:url" content="https://www.thingiverse.com/thing:${id}">`);
      return new Response("", { status: 404 });
    };
    const s = new SmartModelSearch({ apiKey: "key", fetch });
    const state = await s.search("odd thing");
    expect(asked.map((b) => Boolean(b.tools)).sort()).toEqual([false, true]);
    expect(state.results.map((r) => r.thingId)).toEqual(["22", "33"]);
    expect(s.timing?.via).toBe("gemini-web");
  });

  it("shows what Gemini knows at once, then adds the web results", async () => {
    let releaseWeb!: () => void;
    const webGate = new Promise<void>((ok) => (releaseWeb = ok));
    const updates: { more?: boolean; ids: string[] }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("generativelanguage")) {
        const body = JSON.parse(String(init?.body));
        if (!body.tools) return geminiReply([{ pageUrl: "https://www.thingiverse.com/thing:1" }]);
        await webGate; // the slow Google search
        return geminiReply([{ pageUrl: "https://www.thingiverse.com/thing:1" }, { pageUrl: "https://www.thingiverse.com/thing:2" }]);
      }
      const id = /thing:(\d+)/.exec(url)?.[1];
      if (id) return page(`<meta property="og:title" content="Fidget spinner ${id}"><meta property="og:url" content="https://www.thingiverse.com/thing:${id}">`);
      return new Response("", { status: 404 });
    };
    const s = new SmartModelSearch({ apiKey: "key", fetch, onChange: (st) => updates.push({ more: st.more, ids: st.results.map((r) => r.thingId!) }) });
    const first = await s.search("fidget spinner");
    expect(first).toMatchObject({ status: "ready", more: true });
    expect(first.results.map((r) => r.thingId)).toEqual(["1"]);
    releaseWeb();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(updates.at(-1)).toEqual({ more: false, ids: ["1", "2"] }); // web result added, no duplicate
  });

  it("decodes page text (apostrophes and accents)", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("generativelanguage")) return geminiReply([{ pageUrl: "https://www.thingiverse.com/thing:8" }]);
      if (url.includes("thing:8")) return page('<meta property="og:title" content="Kid&#x27;s spinner"><meta property="og:description" content="It&#39;s caf&#233; &amp; fun"><meta property="og:url" content="https://www.thingiverse.com/thing:8">');
      return new Response("", { status: 404 });
    };
    const r = (await new SmartModelSearch({ apiKey: "key", fetch }).search("spinner")).results[0];
    expect(r.name).toBe("Kid's spinner");
    expect(r.description).toBe("It's café & fun");
  });

  it("drops real pages that are about something else", async () => {
    const { relevantTo } = await import("@morphix/model-search");
    expect(relevantTo("fidget spinner", "Afinia H479 Belt Block X")).toBe(false);
    expect(relevantTo("fidget spinner", "Tri Fidget Spinner Toy by 2ROBOTGUY")).toBe(true);
    expect(relevantTo("iPhone 17 cases", "Slim iPhone 17 case")).toBe(true); // plural vs singular
    expect(relevantTo("make me a cool design", "anything")).toBe(true); // nothing specific to check
  });

  it("needs Gemini or a token", async () => {
    const state = await new SmartModelSearch({ fetch: async () => new Response("") }).search("x");
    expect(state).toMatchObject({ status: "failed", error: expect.stringMatching(/GEMINI_API_KEY|THINGIVERSE_TOKEN/) });
  });

  it("downloads every part of a chosen design, a few at a time", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `part${i + 1}.stl`);
    const tv = thingiverse([{ id: 9, name: "Robot arm", files }]);
    const s = new SmartModelSearch({ thingiverseToken: TOK, fetch: tv.fetch });
    const state = await s.search("robot arm");
    const got = await s.download(state.results[0].id);
    expect(got.map((f) => f.name)).toEqual(files);
  });

  it("finds hardware to buy in a description", () => {
    expect(hardwareIn("Needs 4x M3x10 screws, two 6x3 neodymium magnets and a 608zz bearing.")).toEqual(["608zz bearing", "M3x10 screws", "neodymium magnets"]);
    expect(hardwareIn("Print in place, no supports.")).toEqual([]);
  });
});

describe("licence and id helpers", () => {
  it.each([
    ["<div>License</div><div>Creative Commons - Attribution - Non-Commercial - Share Alike</div>", /Creative Commons - Attribution - Non-Commercial - Share Alike/],
    ["licensed CC BY-NC-SA 4.0 by the author", /CC BY-NC-SA 4\.0/],
    ["<span>Standard Digital File License</span>", /Standard Digital File License/],
    ["GNU General Public License v3", /GNU General Public License v3/],
  ])("finds the licence in %s", (page, re) => {
    expect(detectLicense(page)).toMatch(re);
  });

  it("returns null when no licence is stated, and reads Thingiverse ids", () => {
    expect(detectLicense("<p>Great spinner, 300 makes</p>")).toBeNull();
    expect(thingiverseThingId("https://www.thingiverse.com/thing:4242/files")).toBe("4242");
    expect(thingiverseThingId("https://www.printables.com/model/1")).toBeNull();
  });
});

describe("which tool fits the request", () => {
  it.each([
    ["find me an iPhone 17 phone case with a cool design", true],
    ["make me a robotic arm", true],
    ["print me a working fidget spinner", true],
    ["a wall mount for my headphones", true],
    ["a replacement knob for my oven", true],
    ["make me a dragon", false],
    ["make me Mario", false],
    ["a cute robot figure", false],
    ["a dragon with big arms", false],
  ])("%s → real design: %s", (text, expected) => {
    expect(needsRealDesign(text)).toBe(expected);
  });
});
