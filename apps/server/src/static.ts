// Static files: the built React UI (apps/desktop/dist/renderer) and the user's model library.
// Paths are decoded once, ".." / NUL / backslashes are refused, and the real path (symlinks
// resolved) must stay inside its root.
import { createReadStream, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".wav": "audio/wav", ".woff2": "font/woff2", ".woff": "font/woff",
  ".stl": "model/stl", ".glb": "model/gltf-binary", ".3mf": "model/3mf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

/** Decode a URL path; null when it is malformed or tries to climb out ("..", NUL, backslash). */
export function cleanPath(rawUrl: string | undefined): string | null {
  const raw = rawUrl ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const q = raw.search(/[?#]/);
  let path: string;
  try {
    path = decodeURIComponent(q < 0 ? raw : raw.slice(0, q));
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return path;
}

/** A file inside root (symlinks resolved), or null. */
export function safeResolve(root: string, rel: string): string | null {
  if (rel.includes("\0") || rel.includes("\\")) return null;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  const full = resolve(rootReal, "." + sep + rel);
  if (full !== rootReal && !full.startsWith(rootReal + sep)) return null;
  try {
    const real = realpathSync(full);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache = "no-store"): void {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const size = statSync(file).size;
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(size), "Cache-Control": cache, "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const s = createReadStream(file);
  s.on("error", () => res.destroy());
  s.pipe(res);
}

export function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("not found");
}

/** Folders of the data dir the UI may load files from (models, thumbnails, recordings, guardian snapshots). */
export const LIBRARY_DIRS = ["models", "previews", "cache/recordings", "snapshots"];

/** /library/<rel> → a file in one of LIBRARY_DIRS under storageRoot, or null. */
export function libraryFile(storageRoot: string, path: string): string | null {
  if (!path.startsWith("/library/")) return null;
  const rel = path.slice("/library/".length);
  if (!LIBRARY_DIRS.some((d) => rel.startsWith(d + "/"))) return null;
  const file = safeResolve(storageRoot, rel);
  if (!file) return null;
  let root: string;
  try {
    root = realpathSync(storageRoot);
  } catch {
    return null;
  }
  return LIBRARY_DIRS.some((d) => file.startsWith(resolve(root, d) + sep)) ? file : null;
}

/**
 * The UI: "/" and unknown page paths get index.html (single-page app); assets come from the
 * build folder. Returns false when the path isn't a UI file (the caller sends 404).
 */
export function serveRenderer(req: IncomingMessage, res: ServerResponse, rendererDir: string, path: string, onIndex?: () => void): boolean {
  if (path !== "/" && path !== "/index.html") {
    const file = safeResolve(rendererDir, path.slice(1));
    if (file) {
      // Vite puts content-hashed files in assets/: those can be cached.
      sendFile(req, res, file, path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return true;
    }
    // A missing asset is a 404; an extension-less path is a page of the app.
    if (extname(path)) return false;
  }
  const index = safeResolve(rendererDir, "index.html");
  if (!index) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("The Morphix web UI is not built yet. Run: npm run build:renderer");
    return true;
  }
  onIndex?.();
  sendFile(req, res, index, "no-cache");
  return true;
}
