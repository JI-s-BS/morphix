// Tiny helpers: API calls (with the CSRF token) and a safe element builder (no innerHTML).

let csrfToken = "";
export function setCsrf(token) {
  csrfToken = token || "";
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || "Something went wrong");
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", json, body, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body, signal, credentials: "same-origin" });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError(0, "offline", "Can't reach Morphix. Is the Wi-Fi on?");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent("morphix:logged-out"));
    throw new ApiError(res.status, data?.error || "error", data?.message);
  }
  return data;
}

/** Upload a FormData with progress (fetch has no upload progress yet). */
export function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, "offline", "The upload stopped. Is the Wi-Fi on?"));
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) window.dispatchEvent(new CustomEvent("morphix:logged-out"));
        reject(new ApiError(xhr.status, data?.error || "error", data?.message));
      }
    };
    xhr.send(form);
  });
}

/** h("div.card", { onclick }, "text", child) */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Emoji inside a button/label, hidden from screen readers. */
export const emoji = (e) => h("span", { "aria-hidden": "true" }, e);

let toastTimer;
export function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = h("div.toast", { role: "status" }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}
