// Smart Model Search ("open source"): real, free 3D-printable designs from Thingiverse only.
// With THINGIVERSE_TOKEN: Thingiverse's documented API (one search call, then licence, files
// and picture of the top hits in parallel; one-tap download). Without a token: Gemini names
// Thingiverse designs it knows (seconds), Morphix opens every page to confirm it and takes the
// title and picture from the page; only if too few are found does it search the web. Without
// a token Thingiverse gives files only to people, so those are downloaded on the phone (QR).
import { randomUUID } from "node:crypto";
import type { SmartModelResult, SmartSearchState, ModelSource } from "@morphix/shared";

export type { SmartModelResult, SmartSearchState, ModelSource } from "@morphix/shared";
export * from "./parts";

/** Same text model the rest of Morphix uses (advisor, photo analysis). */
export const DEFAULT_SEARCH_MODEL = "gemini-3.8-flash";

const MODEL_FILE = /\.(stl|3mf|obj|ply|glb)$/i;
/** Big multi-part projects (robot arms have 60+ parts) are fine; these only stop runaway downloads. */
export const MAX_FILES = 200;
/** Designs shown per search, and search hits checked to find them. */
const MAX_RESULTS = 4;
const MAX_CANDIDATES = 8;
/** Gemini suggests more than we need: many remembered thing numbers turn out not to exist, and
 * checking a page takes ~0.15 s. */
const GEMINI_CANDIDATES = 12;
/** Thingiverse's generic page title (what a missing thing shows). */
const GENERIC_TV_TITLE = /^Thingiverse\b|community for open hardware/i;
const MAX_FILE_BYTES = 60_000_000;
const MAX_TOTAL_BYTES = 300_000_000;
const clean = (v: unknown, n = 500) => String(v ?? "").trim().slice(0, n);
const list = (v: unknown, n = 8) => (Array.isArray(v) ? v.map((x) => clean(x, 180)).filter(Boolean).slice(0, n) : []);
const meta = (html: string, key: string) => {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']+)["']`, "i").exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${k}["']`, "i").exec(html)?.[1] ??
    ""
  );
};
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** A licence stated on the page itself, if any (null = not found, so not verified). */
export function detectLicense(html: string): string | null {
  const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const patterns = [
    /Creative Commons\s*[-–—]?\s*(?:Attribution|Public Domain|Zero)(?:\s*[-–]\s*|\s+)?(?:Non[-\s]?Commercial)?(?:\s*[-–]\s*|\s+)?(?:Share[-\s]?Alike|No[-\s]?Deriv(?:ative)?s)?(?:\s+\d\.\d)?/i,
    /\bCC[- ]BY(?:[- ](?:NC|SA|ND)){0,2}(?:[- ]\d\.\d)?\b/,
    /\bCC0\b(?:\s*1\.0)?/,
    /Standard Digital File License/i,
    /GNU (?:Lesser |Affero )?General Public License(?: v?\d)?|\b[AL]?GPL(?:v?\d(?:\.\d)?)?\b/,
    /\bMIT License\b|\bBSD License\b/,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0].trim().replace(/\s+/g, " ").slice(0, 80);
  }
  return null;
}

/** Image type from the first bytes. */
function sniffImage(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return null;
}

export const thingiverseThingId = (url: string): string | null => /thing:(\d+)/i.exec(url)?.[1] ?? null;

/** Thingiverse description (HTML or markdown) as plain text. */
const plainText = (s: string) => decode(String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[*_#`>]+/g, " ").replace(/\s+/g, " ").trim();

const HARDWARE: RegExp[] = [
  /\b\d{3}(?:\s?(?:zz|2rs|rs))?\s?bearings?\b/i, /\bbearings?\b/i, /\bM[2-8](?:\s?x\s?\d+)?\s?(?:screws?|bolts?|nuts?)\b/i,
  /\b(?:neodymium\s)?magnets?\b/i, /\b(?:micro\s)?servos?\b/i, /\b(?:stepper|dc|nema\s?\d+)\s?motors?\b/i, /\bsprings?\b/i,
  /\barduino\b/i, /\braspberry pi\b/i, /\brubber bands?\b/i, /\bLEDs?\b/,
];
/** Hardware a description says to buy ("608 bearing", "M3 screws"…), at most 6. */
export function hardwareIn(text: string): string[] {
  const out: string[] = [];
  for (const re of HARDWARE) {
    const m = re.exec(text);
    if (m && !out.some((o) => o.toLowerCase().includes(m[0].toLowerCase()) || m[0].toLowerCase().includes(o.toLowerCase()))) out.push(m[0].trim());
  }
  return out.slice(0, 6);
}

class TokenRejected extends Error {}

const STOP_WORDS = new Set("the and for with make find open source design designs print printable model models thing things free cool small big little one some that this from into your my me a an of to in on".split(" "));
/** Does the page talk about what was asked for? At least one meaningful word of the query (plural or not). */
export function relevantTo(query: string, text: string): boolean {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  if (!words.length) return true;
  const hay = text.toLowerCase();
  return words.some((w) => {
    const stem = w.replace(/(?:es|s)$/, "");
    return hay.includes(stem.length >= 3 ? stem : w);
  });
}

/** Results in rank order, one per thing. */
function pick(checked: (SmartModelResult | null)[]): SmartModelResult[] {
  const out: SmartModelResult[] = [];
  for (const r of checked) {
    if (!r || out.some((x) => x.thingId === r.thingId)) continue;
    out.push(r);
    if (out.length === MAX_RESULTS) break;
  }
  return out;
}

/** "1,234 likes", "56 makes" from a search hit (only counts Thingiverse reports). */
function thingEvidence(hit: Record<string, any>): string[] {
  const out: string[] = [];
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v).toLocaleString("en-US") : null);
  if (n(hit.make_count)) out.push(`${n(hit.make_count)} makes`);
  if (n(hit.like_count)) out.push(`${n(hit.like_count)} likes`);
  if (n(hit.download_count)) out.push(`${n(hit.download_count)} downloads`);
  return out;
}

export interface SmartSearchOptions {
  apiKey?: string;
  model?: string;
  thingiverseToken?: string;
  fetch?: typeof fetch;
  onChange?: (s: SmartSearchState) => void;
  /** Keep a local copy of a result image; returns a URL the UI can show. */
  saveImage?: (resultId: string, bytes: Buffer, contentType: string) => string | null;
  /** QR code (data URL) for a source page, to open it on a phone. */
  qrFor?: (url: string) => Promise<string | null>;
}

export class SmartModelSearch {
  state: SmartSearchState | null = null;

  constructor(private o: SmartSearchOptions) {
    // A placeholder left in the config ("PASTE_APP_TOKEN_HERE") is not a key.
    // Nor is anything with spaces or symbols (e.g. a command pasted by mistake).
    const t = o.thingiverseToken?.trim();
    if (t && (/paste|your_|_here|placeholder|xxx/i.test(t) || !/^[A-Za-z0-9._-]{16,200}$/.test(t))) o.thingiverseToken = undefined;
  }

  private get f(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  /** When the last search finished (ms), for "did we already search for this?". */
  lastFinishedAt = 0;

  private update(s: SmartSearchState): void {
    this.state = s;
    if (s.status !== "searching") this.lastFinishedAt = Date.now();
    this.o.onChange?.(s);
  }

  /** Thingiverse refused the configured token this session; searches go through Gemini instead. */
  tokenRejected = false;

  get thingiverseEnabled(): boolean {
    return Boolean(this.o.thingiverseToken) && !this.tokenRejected;
  }

  async search(query: string): Promise<SmartSearchState> {
    const q = clean(query, 240);
    if (!q) throw new Error("Tell me what model to search for.");
    const id = randomUUID();
    this.imageErrors = [];
    this.update({ id, query: q, status: "searching", results: [] });
    try {
      const started = Date.now();
      let results: SmartModelResult[];
      let hits: Record<string, any>[] | null = null;
      if (this.thingiverseEnabled) {
        try {
          hits = await this.thingiverseSearch(q);
        } catch (e) {
          // A token Thingiverse refuses: search without it rather than fail.
          if (!(e instanceof TokenRejected) || !this.o.apiKey) throw e;
          this.tokenRejected = true;
        }
      }
      if (hits) {
        // With a Thingiverse app token: Thingiverse's own search (about a second) and one-tap downloads.
        const asked = Date.now();
        results = pick(await this.firstUsable(hits.slice(0, MAX_CANDIDATES).map((h) => () => this.fromThingiverse(h))));
        this.timing = { searchMs: asked - started, detailsMs: Date.now() - asked, via: "thingiverse-api" };
      } else {
        // No token: two Gemini searches at once. "Known" (what Gemini remembers, seconds) shows
        // its real, relevant designs straight away; "web" (Google Search, about a minute) adds
        // more to the list when it arrives. Every page is opened to confirm it.
        if (!this.o.apiKey) throw new Error("Open-source search needs Gemini (GEMINI_API_KEY) or a Thingiverse app token (THINGIVERSE_TOKEN).");
        const check = async (items: Record<string, unknown>[]) =>
          pick(await this.firstUsable(items.slice(0, GEMINI_CANDIDATES).map((c) => () => this.fromThingPage(c, q))));
        const web = this.askGemini(q, true).catch(() => [] as Record<string, unknown>[]);
        results = await check(await this.askGemini(q, false).catch(() => []));
        if (results.length > 0 && results.length < MAX_RESULTS) {
          // Show these now; add the web results when they come.
          this.timing = { searchMs: Date.now() - started, detailsMs: 0, via: "gemini-known" };
          const first: SmartSearchState = { id, query: q, status: "ready", results, more: true };
          this.update(first);
          void web.then(check).then((more) => {
            if (this.state?.id !== id) return; // a newer search replaced this one
            const merged = [...this.state.results];
            for (const r of more) if (merged.length < MAX_RESULTS && !merged.some((x) => x.thingId === r.thingId)) merged.push(r);
            this.timing = { searchMs: Date.now() - started, detailsMs: 0, via: "gemini-web" };
            this.update({ ...this.state, results: merged, more: false });
          }).catch(() => {
            if (this.state?.id === id) this.update({ ...this.state, more: false });
          });
          return first;
        }
        if (!results.length) results = await check(await web);
        this.timing = { searchMs: Date.now() - started, detailsMs: 0, via: results.length ? "gemini-web" : "gemini-known" };
      }
      if (!results.length) throw new Error(`Thingiverse has no downloadable designs for “${q}”. Try other words, or I can make one with Claude or Meshy.`);
      const state: SmartSearchState = { id, query: q, status: "ready", results };
      this.update(state);
      return state;
    } catch (e) {
      const state: SmartSearchState = { id, query: q, status: "failed", results: [], error: (e as Error).message };
      this.update(state);
      return state;
    }
  }

  /**
   * Thingiverse's own search (one API call, about a second) — much faster than asking an AI to
   * search the web, which took about a minute.
   */
  private async thingiverseSearch(q: string): Promise<Record<string, any>[]> {
    const url = `https://api.thingiverse.com/search/${encodeURIComponent(q)}/?type=things&sort=relevant&per_page=${MAX_CANDIDATES * 2}`;
    const res = await this.f(url, { headers: this.tvHeaders(), signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) throw new TokenRejected("Thingiverse didn't accept the app token (THINGIVERSE_TOKEN). Ask a grown-up to check it.");
    if (!res.ok) throw new Error(`Thingiverse search didn't answer (${res.status}). Try again in a moment.`);
    const body = (await res.json()) as unknown;
    const hits = Array.isArray(body) ? body : Array.isArray((body as { hits?: unknown })?.hits) ? (body as { hits: unknown[] }).hits : [];
    return hits.filter((h): h is Record<string, any> => Boolean(h && typeof h === "object" && Number.isFinite(Number((h as { id?: unknown }).id))));
  }

  /**
   * Thingiverse designs from Gemini (no token needed). `web` = with Google Search (slow, finds
   * newer designs); without it Gemini answers from what it knows in a few seconds. Every
   * suggestion is checked against the real page afterwards, so invented links never show.
   */
  private async askGemini(q: string, web: boolean): Promise<Record<string, unknown>[]> {
    const prompt = `List up to ${GEMINI_CANDIDATES} real, free 3D-printable designs on Thingiverse for: ${JSON.stringify(q)}.
Only Thingiverse thing pages (https://www.thingiverse.com/thing:NUMBER) that you are confident exist; popular, well-made designs first; for things that must fit, the exact model/size asked for.
Return ONLY a JSON array, no prose. Each item: {"pageUrl","description","parts","nonPrintedParts","assembly","printAsIs"}.
- parts: separately printed parts. nonPrintedParts: hardware to buy (bearings, screws, magnets…), empty if none. printAsIs: true only with no hardware and no assembly.`;
    const body = (thinking: boolean) =>
      JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(web ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature: 0.2, ...(thinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}) },
      });
    const call = (thinking: boolean) =>
      this.f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.o.model || DEFAULT_SEARCH_MODEL)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.o.apiKey! },
        body: body(thinking),
        signal: AbortSignal.timeout(web ? 90_000 : 25_000),
      });
    let res = await call(true);
    if (res.status === 400) res = await call(false); // model without thinking levels
    if (!res.ok) throw new Error(`Gemini search failed (${res.status})`);
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const json = /\[[\s\S]*\]/.exec(text.replace(/```(?:json)?/g, ""))?.[0];
    if (!json) return [];
    try {
      const raw = JSON.parse(json) as unknown;
      return Array.isArray(raw) ? (raw.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }

  /** A Thingiverse page Gemini suggested, confirmed by opening it (title and picture from the page). */
  private async fromThingPage(item: Record<string, unknown>, query = ""): Promise<SmartModelResult | null> {
    const thingId = thingiverseThingId(clean(item.pageUrl, 300));
    if (!thingId) return null;
    const pageUrl = `https://www.thingiverse.com/thing:${thingId}`;
    const page = await this.f(pageUrl, { headers: { "User-Agent": "Morphix/1.0 (model link check)" }, redirect: "follow", signal: AbortSignal.timeout(6_000) });
    if (!page.ok || !String(page.headers.get("content-type")).includes("text/html")) return null;
    const html = (await page.text()).slice(0, 1_500_000);
    const title = clean(decode(meta(html, "og:title")), 160);
    // Thingiverse answers a made-up thing number with its generic page (200, no og:url): only a
    // page that names this exact thing counts.
    if (!title || GENERIC_TV_TITLE.test(title) || thingiverseThingId(decode(meta(html, "og:url"))) !== thingId) return null;
    // Gemini sometimes remembers a real thing number for the wrong design: it must be about the request.
    if (!relevantTo(query, `${title} ${decode(meta(html, "og:description"))}`)) return null;
    const license = detectLicense(html);
    const nonPrinted = list(item.nonPrintedParts);
    const r: SmartModelResult = {
      id: randomUUID(),
      source: "thingiverse",
      name: title.replace(/\s+by\s+[^|]+$/i, "").slice(0, 120) || title,
      pageUrl,
      imageUrl: clean(decode(meta(html, "og:image")), 1200) || null,
      thumbUrl: null,
      qrDataUrl: null,
      description: clean(decode(meta(html, "og:description")) || item.description, 500),
      license,
      licenseVerified: license !== null,
      creator: /\sby\s+(.+)$/i.exec(title)?.[1]?.trim().slice(0, 100) ?? null,
      parts: list(item.parts),
      nonPrintedParts: nonPrinted,
      assembly: list(item.assembly),
      printAsIs: Boolean(item.printAsIs) && nonPrinted.length === 0,
      evidence: [],
      files: [],
      download: "needs-key", // Thingiverse only gives files to apps with a token: download on the phone
      thingId,
    };
    await this.addImage(r);
    r.qrDataUrl = (await this.o.qrFor?.(r.pageUrl).catch(() => null)) ?? null;
    return r;
  }

  private tvHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.o.thingiverseToken}`, "User-Agent": "Morphix/1.0" };
  }

  /** A search hit with its licence, files and picture; null if it has nothing Morphix can download. */
  private async fromThingiverse(hit: Record<string, any>): Promise<SmartModelResult | null> {
    const thingId = String(Math.trunc(Number(hit.id)));
    const publicUrl = clean(hit.public_url, 300);
    const r: SmartModelResult = {
      id: randomUUID(),
      source: "thingiverse",
      name: clean(hit.name, 120) || `Thing ${thingId}`,
      pageUrl: /^https:\/\/(www\.)?thingiverse\.com\/thing:\d+/.test(publicUrl) ? publicUrl : `https://www.thingiverse.com/thing:${thingId}`,
      imageUrl: clean(hit.preview_image || hit.thumbnail, 1200) || null,
      thumbUrl: null,
      qrDataUrl: null,
      description: "",
      license: null,
      licenseVerified: false,
      creator: clean(hit.creator?.name, 100) || null,
      parts: [], nonPrintedParts: [], assembly: [],
      printAsIs: false,
      evidence: thingEvidence(hit),
      files: [],
      download: "manual",
      thingId,
    };
    await this.addThingiverseDetails(r);
    if (r.download !== "thingiverse-api") return null; // no STL/3MF files to download
    await this.addImage(r);
    r.qrDataUrl = (await this.o.qrFor?.(r.pageUrl).catch(() => null)) ?? null;
    return r;
  }

  /**
   * Runs the checks in parallel and stops waiting once MAX_RESULTS usable ones are in and every
   * better-ranked one has answered (the slowest one used to hold every search up).
   */
  private firstUsable(tasks: (() => Promise<SmartModelResult | null>)[]): Promise<(SmartModelResult | null)[]> {
    return new Promise((resolve) => {
      const out: (SmartModelResult | null | undefined)[] = tasks.map(() => undefined);
      let pending = tasks.length;
      let usable = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(out.map((r) => r ?? null));
      };
      if (!pending) return finish();
      tasks.forEach((task, i) => {
        task()
          .catch(() => null)
          .then((r) => {
            out[i] = r;
            if (r) usable++;
            pending--;
            if (pending === 0 || (usable >= MAX_RESULTS && out.slice(0, i).every((x) => x !== undefined))) finish();
          });
      });
    });
  }

  private async addImage(r: SmartModelResult): Promise<void> {
    if (!r.imageUrl || !this.o.saveImage) return;
    try {
      const u = new URL(r.imageUrl, r.pageUrl);
      if (u.protocol !== "https:") return;
      const img = await this.f(u, { headers: { "User-Agent": "Morphix/1.0 (model preview)" }, redirect: "follow", signal: AbortSignal.timeout(6_000) });
      if (!img.ok) throw new Error(`image HTTP ${img.status}`);
      const bytes = Buffer.from(await img.arrayBuffer());
      if (bytes.length > 4_000_000 || bytes.length < 64) throw new Error(`image size ${bytes.length}`);
      // Trust the bytes rather than the header (some CDNs label images application/octet-stream).
      const type = sniffImage(bytes) ?? String(img.headers.get("content-type"));
      if (!/^image\/(jpeg|png|webp|gif)/.test(type)) throw new Error(`not an image (${type})`);
      r.thumbUrl = this.o.saveImage(r.id, bytes, type);
    } catch (e) {
      // No picture is fine: the card shows a placeholder and the QR code still opens the page.
      this.imageErrors.push(`${r.source}: ${(e as Error).message}`);
    }
  }

  /** Why result pictures couldn't be fetched in the last search (for the log). */
  imageErrors: string[] = [];
  /** How long the last search spent asking Gemini and checking pages (for the log). */
  timing: { searchMs: number; detailsMs: number; via: "thingiverse-api" | "gemini-known" | "gemini-web" } | null = null;

  /** Thingiverse's documented API: real licence, creator and file list (needs a token). */
  private async addThingiverseDetails(r: SmartModelResult): Promise<void> {
    const thingId = thingiverseThingId(r.pageUrl);
    if (!thingId) return;
    r.thingId = thingId;
    if (!this.o.thingiverseToken) {
      r.download = "needs-key"; // Thingiverse only allows downloads through its API, with a key
      return;
    }
    try {
      const h = { Authorization: `Bearer ${this.o.thingiverseToken}` };
      const thing = (await (await this.f(`https://api.thingiverse.com/things/${thingId}`, { headers: h, signal: AbortSignal.timeout(8_000) })).json()) as {
        name?: string; license?: string; creator?: { name?: string }; default_image?: { url?: string }; description?: string;
      };
      const files = (await (await this.f(`https://api.thingiverse.com/things/${thingId}/files`, { headers: h, signal: AbortSignal.timeout(8_000) })).json()) as { id?: number; name?: string; size?: number }[];
      if (thing.license) {
        r.license = clean(thing.license, 100);
        r.licenseVerified = true;
      }
      if (thing.creator?.name) r.creator = clean(thing.creator.name, 100);
      if (!r.imageUrl && thing.default_image?.url) r.imageUrl = thing.default_image.url;
      r.files = (Array.isArray(files) ? files : []).filter((f) => MODEL_FILE.test(String(f.name))).map((f) => ({ name: clean(f.name, 120), sizeBytes: Number(f.size) || 0 }));
      r.thingId = thingId;
      const text = plainText(thing.description ?? "");
      if (!r.description && text) r.description = clean(text, 500);
      if (!r.parts.length) r.parts = r.files.map((f) => f.name.replace(MODEL_FILE, "")).slice(0, 12);
      if (!r.nonPrintedParts.length) r.nonPrintedParts = hardwareIn(text);
      // One printed part and no hardware mentioned = prints as it is.
      r.printAsIs = r.files.length === 1 && r.nonPrintedParts.length === 0;
      if (r.files.length) r.download = "thingiverse-api";
    } catch {
      /* API down or token rejected: fall back to the normal manual download */
    }
  }

  /** Get every model file for a result, through its site's supported route. */
  async download(id: string): Promise<{ name: string; bytes: Buffer }[]> {
    const r = this.find(id);
    if (!r) throw new Error("That search result is no longer available — search again.");
    if (r.download === "thingiverse-api") return this.downloadThingiverse(id);
    if (r.download === "needs-key") {
      throw new Error("Thingiverse only lets apps download its files with a Thingiverse app token, so get this one on your phone: scan the QR code (or open the link), tap Download, then send the files to Morphix.");
    }
    throw new Error("Morphix can't download this design by itself.");
  }

  select(id: string): SmartModelResult {
    const result = this.state?.results.find((r) => r.id === id);
    if (!result) throw new Error("That search result is no longer available — search again.");
    this.update({ ...this.state!, selectedId: id });
    return result;
  }

  find(id: string): SmartModelResult | undefined {
    return this.state?.results.find((r) => r.id === id);
  }

  /**
   * Downloads a Thingiverse design's model files through the official API. Only for results
   * marked download "thingiverse-api"; every other site is downloaded by the user.
   */
  async downloadThingiverse(id: string, limits = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES }): Promise<{ name: string; bytes: Buffer }[]> {
    const r = this.find(id);
    if (!r) throw new Error("That search result is no longer available — search again.");
    if (r.download !== "thingiverse-api" || !r.thingId || !this.o.thingiverseToken) {
      throw new Error("This design has to be downloaded from its own page (open the link or scan the QR code), then imported into Morphix.");
    }
    const h = { Authorization: `Bearer ${this.o.thingiverseToken}` };
    const files = (await (await this.f(`https://api.thingiverse.com/things/${r.thingId}/files`, { headers: h, signal: AbortSignal.timeout(10_000) })).json()) as { id?: number; name?: string; size?: number; download_url?: string }[];
    const wanted = (Array.isArray(files) ? files : []).filter((f) => MODEL_FILE.test(String(f.name)) && f.id);
    if (!wanted.length) throw new Error("Thingiverse lists no STL/3MF files for this design.");
    if (wanted.length > limits.maxFiles) throw new Error(`This design has ${wanted.length} files — download it from the page and import the parts you need.`);
    const out: { name: string; bytes: Buffer }[] = new Array(wanted.length);
    let total = 0;
    let next = 0;
    // A few at a time: multi-part designs have dozens of files.
    const worker = async () => {
      while (next < wanted.length) {
        const i = next++;
        const f = wanted[i];
        const res = await this.f(f.download_url || `https://api.thingiverse.com/files/${f.id}/download`, { headers: h, redirect: "follow", signal: AbortSignal.timeout(90_000) });
        if (!res.ok) throw new Error(`Thingiverse refused the download of ${f.name} (${res.status}).`);
        const bytes = Buffer.from(await res.arrayBuffer());
        total += bytes.length;
        if (bytes.length > limits.maxFileBytes || total > limits.maxTotalBytes) throw new Error("The files are too big to download here — use the page instead.");
        out[i] = { name: clean(f.name, 120), bytes };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));
    return out;
  }
}
