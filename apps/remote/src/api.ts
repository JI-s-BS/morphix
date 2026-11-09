// Production always uses Vercel's same-origin /api proxy. A direct Pi URL is
// accepted only by the local Vite development server, never in a Vercel build.
export const API = import.meta.env.DEV
  ? (import.meta.env.VITE_MORPHIX_REMOTE_URL as string | undefined)?.replace(/\/$/, "") ?? ""
  : "";
const key = "morphix.remote.token";
export const token = () => localStorage.getItem(key) ?? "";
export const saveToken = (v: string) => localStorage.setItem(key, v);
export const forgetToken = () => localStorage.removeItem(key);
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers); if (token()) headers.set("Authorization", `Bearer ${token()}`);
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const res = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/pair")) forgetToken();
  if (!res.ok) throw new Error(data.message || String(data.error || `Request failed (${res.status})`).replaceAll("_", " "));
  return data as T;
}
export const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
export const asset = (path: string) => `${API}${path}`;
export async function authedBlob(path: string): Promise<Blob> { const r = await fetch(asset(path), { headers: { Authorization: `Bearer ${token()}` } }); if (!r.ok) throw new Error("Could not load model"); return r.blob(); }
