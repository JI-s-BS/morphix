// Morphix portal front-end. Plain ES modules, hash routes, no build step.
import { api, upload, h, emoji, toast, setCsrf, ApiError } from "./api.js";

const app = document.getElementById("app");
let me = null;
let cleanup = null;

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_SCAN_BYTES = 100 * 1024 * 1024;
const MAX_TEXT = 1000;
const REFERENCES = [
  ["none", "🚫", "Nothing"],
  ["credit-card", "💳", "Bank card"],
  ["coin", "🪙", "Coin"],
  ["ruler", "📏", "Ruler"],
  ["phone", "📱", "Phone"],
];

// The "Make something" form survives switching tabs.
const draft = { mode: "photos", photos: [], scan: null, text: "", reference: "none", measurements: [] };

// ---------- Boot & routing ----------

async function boot() {
  try {
    me = await api("/api/me");
    setCsrf(me.csrfToken);
  } catch (err) {
    me = null;
    if (err instanceof ApiError && err.status === 503) return renderNotConfigured();
    if (!(err instanceof ApiError && err.status === 401)) return renderFatal(err);
  }
  chrome();
  window.addEventListener("hashchange", route);
  window.addEventListener("morphix:logged-out", () => {
    me = null;
    chrome();
    route();
  });
  route();
  if (me) pollActions();
}

function chrome() {
  const signedIn = !!me;
  document.getElementById("topbar").hidden = !signedIn;
  document.getElementById("tabbar").hidden = !signedIn;
  if (!signedIn) return;
  const avatar = document.getElementById("avatar");
  const name = me.displayName || me.user.name || me.user.email;
  avatar.textContent = me.user.picture ? "" : name.slice(0, 1).toUpperCase();
  if (me.user.picture) avatar.style.backgroundImage = `url("${me.user.picture.replace(/"/g, "")}")`;
  document.getElementById("menu-name").textContent = `Hi, ${name}!${me.user.isAdmin ? " 🛠️" : ""}`;
  document.getElementById("menu-email").textContent = me.user.email;
  const menu = document.getElementById("menu");
  avatar.onclick = () => (menu.hidden = !menu.hidden);
  document.getElementById("logout").onclick = async () => {
    try {
      const { url } = await api("/logout", { method: "POST" });
      location.href = url;
    } catch {
      location.href = "/";
    }
  };
  const tabs = document.querySelectorAll(".tabbar a");
  const f = me.features || {};
  tabs.forEach((a) => {
    if (a.dataset.tab === "printer" && f.printer === false) a.hidden = true;
  });
}

function route() {
  document.getElementById("menu").hidden = true;
  cleanup?.();
  cleanup = null;
  app.replaceChildren();
  window.scrollTo(0, 0);
  if (!me) return renderLogin();
  const [, name = "make", arg] = location.hash.replace(/^#/, "").split("/");
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name || (name === "thing" && a.dataset.tab === "things")));
  const screens = { make: renderMake, job: renderJob, actions: renderActions, things: renderThings, thing: renderThing, printer: renderPrinter };
  (screens[name] || renderMake)(arg ? decodeURIComponent(arg) : undefined);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------- Simple screens ----------

function renderLogin() {
  app.append(
    h("div.center.stack", [
      h("div.hero-emoji", { "aria-hidden": "true" }, "🪄"),
      h("h1", "Hi! Let's make something"),
      h("p", "Take photos of a thing or say what you want, and Morphix turns it into a 3D print."),
      h("a.btn.btn-primary.btn-big", { href: "/login" }, emoji("🔑"), "Sign in"),
      h("p.small", "A grown-up has to add you to the list first."),
    ]),
  );
}

function renderNotConfigured() {
  app.replaceChildren(h("div.center.stack", [h("div.hero-emoji", "🔧"), h("h1", "Morphix needs a grown-up"), h("p", "Sign-in isn't set up yet. See docs/PORTAL.md.")]));
}

function renderFatal(err) {
  app.replaceChildren(
    h("div.center.stack", [h("div.hero-emoji", "😵"), h("h1", "Uh-oh"), h("p", err?.message || "Something went wrong."), h("button.btn.btn-primary", { onclick: () => location.reload() }, emoji("🔄"), "Try again")]),
  );
}

function errorCard(error, retry) {
  return h("div.card.error-card.stack", [
    h("h2", emoji("😕"), " ", error.message || "Something went wrong"),
    error.code ? h("p", "Error code ", h("span.error-code", error.code)) : null,
    error.hint ? h("div.hint", h("strong", "💡 What to try: "), error.hint) : null,
    retry ? h("button.btn.btn-primary", { onclick: retry }, emoji("🔁"), "Try again") : null,
  ]);
}

// ---------- Make something ----------

function renderMake() {
  const f = me.features || {};
  const canPhoto = f.photo !== false;
  const canText = f.text !== false;
  if (!canPhoto) draft.mode = "words";
  if (!canText) draft.mode = "photos";

  const body = h("div.stack");
  const seg =
    canPhoto && canText
      ? h(
          "div.segmented",
          { role: "group", "aria-label": "How do you want to make it?" },
          h("button", { type: "button", "aria-pressed": String(draft.mode === "photos"), onclick: () => ((draft.mode = "photos"), route()) }, "📸 From photos"),
          h("button", { type: "button", "aria-pressed": String(draft.mode === "words"), onclick: () => ((draft.mode = "words"), route()) }, "💬 From words"),
        )
      : null;
  app.append(h("h1", "Make something ✨"), seg, body);
  if (me.generationsLeftToday !== undefined) app.insertBefore(h("p.small", `You can make ${me.generationsLeftToday} more today.`), body);

  draft.mode === "photos" ? photoForm(body) : wordsForm(body);
}

function textBox(placeholder) {
  const counter = h("div.counter", `${[...draft.text].length} / ${MAX_TEXT}`);
  const ta = h("textarea", {
    id: "what",
    maxLength: MAX_TEXT,
    placeholder,
    oninput: (e) => {
      draft.text = e.target.value;
      counter.textContent = `${[...draft.text].length} / ${MAX_TEXT}`;
    },
  });
  ta.value = draft.text;
  return h("div", h("label.field", { for: "what" }, "🗣️ What should I make?"), ta, counter);
}

function wordsForm(body) {
  const btn = h("button.btn.btn-primary.btn-big", { type: "button" }, emoji("✨"), "Make it!");
  btn.onclick = async () => {
    if (!draft.text.trim()) return toast("Tell me what to make first 🙂");
    btn.disabled = true;
    try {
      const { jobId } = await api("/api/text-requests", { method: "POST", json: { prompt: draft.text } });
      draft.text = "";
      go(`#/job/${encodeURIComponent(jobId)}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  };
  body.append(h("div.card.stack", textBox("A dragon keychain, a dinosaur pencil holder, a name tag that says LEO…")), btn);
}

function photoForm(body) {
  const thumbs = h("div");
  const drawThumbs = () => {
    thumbs.replaceChildren(
      draft.photos.length
        ? h(
            "div.thumbs",
            draft.photos.map((p, i) => {
              const img = h("img", { src: p.url, alt: `Photo ${i + 1}` });
              const box = h("div.thumb", img, h("button.remove", { type: "button", "aria-label": `Remove photo ${i + 1}`, onclick: () => removePhoto(i) }, "✖"));
              img.onerror = () => img.replaceWith(h("span", { "aria-hidden": "true" }, "🖼️"));
              return box;
            }),
          )
        : h("div.empty", "No photos yet. Take a few from different sides! 📷"),
      h("p.small", `${draft.photos.length} of ${MAX_PHOTOS} photos`),
    );
  };
  const removePhoto = (i) => {
    URL.revokeObjectURL(draft.photos[i].url);
    draft.photos.splice(i, 1);
    drawThumbs();
  };
  const addFiles = (files) => {
    for (const file of files) {
      if (draft.photos.length >= MAX_PHOTOS) {
        toast(`That's ${MAX_PHOTOS} photos, the most I can take 🙂`);
        break;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        toast(`${file.name} is too big (15 MB max)`);
        continue;
      }
      draft.photos.push({ file, url: URL.createObjectURL(file) });
    }
    drawThumbs();
  };
  const fileButton = (label, icon, attrs) =>
    h(
      "label.btn.btn-file.grow",
      emoji(icon),
      label,
      h("input", { type: "file", accept: "image/*", ...attrs, onchange: (e) => (addFiles([...e.target.files]), (e.target.value = "")) }),
    );
  drawThumbs();

  const scanInfo = h("p.small");
  const drawScan = () => (scanInfo.textContent = draft.scan ? `🧊 ${draft.scan.name} (${(draft.scan.size / 1e6).toFixed(1)} MB)` : "From an app like Polycam: OBJ, PLY, STL or GLB.");
  drawScan();
  const scanInput = h("input", {
    type: "file",
    accept: ".obj,.ply,.stl,.glb,model/*",
    onchange: (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > MAX_SCAN_BYTES) return toast("That scan is too big (100 MB max)");
      draft.scan = file;
      drawScan();
      clearScan.hidden = false;
    },
  });
  const clearScan = h("button.btn.btn-bad", { type: "button", hidden: !draft.scan, onclick: () => ((draft.scan = null), drawScan(), (clearScan.hidden = true)) }, "Remove scan");

  const uploadBar = h("div.progress", { hidden: true }, h("div"));
  const go_ = h("button.btn.btn-primary.btn-big", { type: "button" }, emoji("✨"), "Make it!");
  go_.onclick = async () => {
    if (!draft.photos.length && !draft.scan) return toast("Add a photo first 📸");
    const form = new FormData();
    for (const p of draft.photos) form.append("images", p.file, p.file.name);
    if (draft.scan) form.append("scan", draft.scan, draft.scan.name);
    form.append("description", draft.text.slice(0, MAX_TEXT));
    form.append("referenceObject", draft.reference);
    form.append("measurements", JSON.stringify(draft.measurements.filter((m) => m.label && Number(m.value) > 0).map((m) => ({ ...m, value: Number(m.value) }))));
    go_.disabled = true;
    uploadBar.hidden = false;
    try {
      const { jobId } = await upload("/api/requests", form, (p) => (uploadBar.firstChild.style.width = `${Math.round(p * 100)}%`));
      draft.photos.forEach((p) => URL.revokeObjectURL(p.url));
      Object.assign(draft, { photos: [], scan: null, text: "", reference: "none", measurements: [] });
      go(`#/job/${encodeURIComponent(jobId)}`);
    } catch (err) {
      toast(err.message);
      go_.disabled = false;
      uploadBar.hidden = true;
    }
  };

  body.append(
    h("div.card.stack", [
      h("h2", "📸 Photos"),
      h("div.row", fileButton("Take a photo", "📷", { capture: "environment" }), fileButton("Pick photos", "🖼️", { multiple: true })),
      thumbs,
    ]),
    h("div.card.stack", textBox("What is it? What should it do? e.g. “My toy car, but as a keychain”")),
    sizeHelper(),
    h("details.card.helper", { open: !!draft.scan }, h("summary", emoji("🧊"), "Add a 3D scan (optional)"), h("div.stack", h("label.btn.btn-file", emoji("📂"), "Choose scan file", scanInput), scanInfo, clearScan)),
    uploadBar,
    go_,
  );
}

function sizeHelper() {
  const chips = h(
    "div.chips",
    { role: "radiogroup", "aria-label": "Reference object" },
    REFERENCES.map(([value, icon, label]) => {
      const input = h("input", { type: "radio", name: "ref", value, checked: draft.reference === value });
      const chip = h("label.chip", { class: draft.reference === value ? "selected" : "" }, input, h("span", { "aria-hidden": "true" }, icon), label);
      input.onchange = () => {
        draft.reference = value;
        chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("selected", c === chip));
      };
      return chip;
    }),
  );
  const rows = h("div.stack");
  const drawRows = () => {
    rows.replaceChildren(
      ...draft.measurements.map((m, i) => {
        const label = h("input", { type: "text", placeholder: "e.g. Height", maxLength: 40, "aria-label": "What you measured", oninput: (e) => (m.label = e.target.value) });
        label.value = m.label;
        const value = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", placeholder: "10", "aria-label": "Number", oninput: (e) => (m.value = e.target.value) });
        value.value = m.value;
        const unit = h("select", { "aria-label": "Unit", onchange: (e) => (m.unit = e.target.value) }, ["mm", "cm", "in"].map((u) => h("option", { value: u, selected: m.unit === u }, u)));
        return h("div.measure-row", label, value, unit, h("button.icon-btn", { type: "button", "aria-label": "Remove size", onclick: () => (draft.measurements.splice(i, 1), drawRows()) }, "✖"));
      }),
    );
    add.hidden = draft.measurements.length >= 10;
  };
  const add = h("button.btn", { type: "button", onclick: () => (draft.measurements.push({ label: "", value: "", unit: "cm" }), drawRows()) }, emoji("➕"), "Add a size");
  drawRows();
  return h(
    "details.card.helper",
    { open: draft.reference !== "none" || draft.measurements.length > 0 },
    h("summary", emoji("📏"), "Do you know a size?"),
    h("div.stack", [
      h("p", "Put something everyone knows next to your thing in the photo, so Morphix can tell how big it is:"),
      chips,
      h("p", "Or tell me a size you measured:"),
      rows,
      add,
    ]),
  );
}

// ---------- Progress ----------

function renderJob(jobId) {
  if (!jobId) return go("#/make");
  const bar = h("div.progress", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, h("div"));
  const pct = h("div.progress-label", "0%");
  const stage = h("h2", "Getting started… 🚀");
  const stages = h("ul.stages");
  const extra = h("div.stack");
  app.append(h("h1", "Making it! 🛠️"), h("div.card.stack", pct, bar, stage, stages), extra);

  let lastAction = null;
  const show = async (e) => {
    const p = Math.max(0, Math.min(100, Math.round(e.progress || 0)));
    bar.firstChild.style.width = `${p}%`;
    bar.setAttribute("aria-valuenow", String(p));
    pct.textContent = `${p}%`;
    stage.textContent = e.message || e.stage || "";
    stages.replaceChildren(
      ...(e.stages || []).map((s) => h(`li.${s.state}`, h("span.tick", { "aria-hidden": "true" }, { done: "✓", active: "⏳", failed: "✖", skipped: "–", pending: "" }[s.state] ?? ""), s.label)),
    );
    if (e.status === "failed") {
      extra.replaceChildren(errorCard(e.error || { message: "Something went wrong" }, () => go("#/make")));
    } else if (e.status === "succeeded") {
      extra.replaceChildren(
        h("div.card.center.stack", [
          h("div.hero-emoji", "🎉"),
          h("h2", "All done!"),
          e.projectId ? h("a.btn.btn-primary.btn-big", { href: `#/thing/${encodeURIComponent(e.projectId)}` }, emoji("👀"), "See it") : null,
        ]),
      );
    } else if (e.status === "cancelled") {
      extra.replaceChildren(h("div.card.stack", h("h2", "Stopped 🛑"), h("p", e.message || "Nothing was made."), h("a.btn", { href: "#/make" }, "Make something else")));
    } else if (e.status === "waiting" && e.actionId && e.actionId !== lastAction) {
      lastAction = e.actionId;
      const { actions } = await api("/api/actions").catch(() => ({ actions: [] }));
      const action = actions.find((a) => a.id === e.actionId);
      extra.replaceChildren(action ? actionCard(action, () => extra.replaceChildren()) : h("p.small", "Waiting for a yes on the Morphix screen…"));
    } else if (e.status !== "waiting") {
      lastAction = null;
      extra.replaceChildren();
    }
  };

  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  source.addEventListener("job", (msg) => {
    try {
      const e = JSON.parse(msg.data);
      show(e);
      if (["succeeded", "failed", "cancelled"].includes(e.status)) source.close();
    } catch {
      /* ignore */
    }
  });
  let errors = 0;
  source.onerror = () => {
    if (++errors > 5) {
      source.close();
      extra.replaceChildren(errorCard({ message: "Lost touch with Morphix.", hint: "Check the Wi-Fi, then tap Try again." }, () => route()));
    }
  };
  source.onopen = () => (errors = 0);
  cleanup = () => source.close();
}

// ---------- Confirmations ----------

function actionCard(action, done) {
  const isPrint = action.kind === "print";
  const yes = h("button.btn.btn-good.btn-big", { type: "button" }, emoji(isPrint ? "🖨️" : "👍"), isPrint ? "Yes, print it!" : "Yes, make it!");
  const no = h("button.btn.btn-bad", { type: "button" }, "No thanks");
  const answer = async (what) => {
    yes.disabled = no.disabled = true;
    try {
      const r = await api(`/api/actions/${encodeURIComponent(action.id)}/${what}`, { method: "POST" });
      if (r && r.ok === false) toast(r.message || "That didn't work");
      else toast(what === "confirm" ? "Great, here we go! 🚀" : "Okay, stopped. Nothing was spent.");
      done?.();
    } catch (err) {
      toast(err.message);
      yes.disabled = no.disabled = false;
    }
  };
  yes.onclick = () => answer("confirm");
  no.onclick = () => answer("cancel");
  const needsAdmin = isPrint && !me.user.isAdmin;
  if (needsAdmin) yes.disabled = true;
  return h("div.card.action-card.stack", [
    h("h2", emoji(isPrint ? "🖨️" : "🪙"), " ", action.title),
    action.details?.length ? h("ul", action.details.map((d) => h("li", d))) : null,
    needsAdmin ? h("p.small", "Only a grown-up can say yes to printing.") : null,
    yes,
    no,
  ]);
}

async function renderActions() {
  app.append(h("h1", "Questions for you ✋"));
  const list = h("div.stack", h("div.center", h("div.spinner")));
  app.append(list);
  const load = async () => {
    try {
      const { actions } = await api("/api/actions");
      list.replaceChildren(...(actions.length ? actions.map((a) => actionCard(a, load)) : [h("div.empty", "Nothing to answer right now 😊")]));
      updateBadge(actions.length);
    } catch (err) {
      list.replaceChildren(errorCard(err, load));
    }
  };
  load();
}

function updateBadge(n) {
  const badge = document.getElementById("actions-badge");
  badge.hidden = !n;
  document.getElementById("actions-count").textContent = String(n);
  badge.lastChild.textContent = n === 1 ? " question" : " questions";
}

function pollActions() {
  const tick = async () => {
    if (!me) return;
    if (!document.hidden) {
      try {
        updateBadge((await api("/api/actions")).actions.length);
      } catch {
        /* ignore */
      }
    }
    setTimeout(tick, 10_000);
  };
  tick();
}

// ---------- My things ----------

async function renderThings() {
  app.append(h("h1", "My things 🧸"));
  const grid = h("div", h("div.center", h("div.spinner")));
  app.append(grid);
  try {
    const { projects } = await api("/api/projects");
    if (!projects.length) {
      grid.replaceChildren(h("div.empty.stack", h("p", "Nothing here yet!"), h("a.btn.btn-primary", { href: "#/make" }, emoji("✨"), "Make your first thing")));
      return;
    }
    grid.replaceChildren(
      h(
        "div.gallery",
        projects.map((p) =>
          h(
            "a.card.thing",
            { href: `#/thing/${encodeURIComponent(p.id)}` },
            h("div.pic", p.hasThumbnail && p.latestVersionId ? h("img", { src: `/api/thumbnails/${encodeURIComponent(p.latestVersionId)}`, alt: "", loading: "lazy" }) : h("span", { "aria-hidden": "true" }, "🧊")),
            h("h3", p.title || "Untitled"),
          ),
        ),
      ),
    );
  } catch (err) {
    grid.replaceChildren(errorCard(err, () => route()));
  }
}

async function renderThing(id) {
  if (!id) return go("#/things");
  app.append(h("a.btn", { href: "#/things" }, emoji("⬅️"), "Back"));
  const body = h("div.stack", h("div.center", h("div.spinner")));
  app.append(body);
  let viewer = null;
  let disposed = false;
  cleanup = () => {
    disposed = true;
    viewer?.dispose();
  };
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(id)}`);
    const latest = project.versions.find((v) => v.id === project.latestVersionId) || project.versions[project.versions.length - 1];
    const stage = h("div.viewer", h("div.overlay", "Loading 3D… 🧊"));
    const sizeLine = h("p.small");
    body.replaceChildren(
      h("h1", project.title || "Untitled"),
      project.prompt && project.prompt !== project.title ? h("p", project.prompt) : null,
      stage,
      h("p.small", "👆 Drag to spin · 🤏 pinch to zoom"),
      sizeLine,
      latest ? h("a.btn", { href: `/api/models/${encodeURIComponent(latest.id)}`, download: `${project.title || "model"}.${latest.format}` }, emoji("💾"), "Download") : null,
    );
    if (!latest) return stage.firstChild.replaceChildren("No 3D model yet");
    try {
      const { showModel } = await import("./viewer.js");
      if (disposed) return;
      viewer = await showModel(stage, `/api/models/${encodeURIComponent(latest.id)}`, latest.format);
    } catch {
      stage.replaceChildren(h("div.overlay", "This device can't show 3D here 🙈 — but you can still download it."));
      return;
    }
    if (disposed) return viewer.dispose();
    stage.querySelector(".overlay")?.remove();
    if (latest.targetHeightMm) sizeLine.textContent = `About ${Math.round(latest.targetHeightMm)} mm tall when printed`;
  } catch (err) {
    body.replaceChildren(errorCard({ message: err.message || "Couldn't show this one" }, () => route()));
  }
}

// ---------- Printer ----------

const STATE_EMOJI = { idle: "😴", printing: "🖨️", paused: "⏸️", heating: "🔥", offline: "🔌", error: "⚠️", done: "✅" };

function renderPrinter() {
  const f = me.features || {};
  const camWrap = h("div");
  const status = h("div.card.stack", h("div.center", h("div.spinner")));
  const controls = h("div");
  app.append(h("h1", "Printer 🖨️"), camWrap, status, controls);

  let camOn = false;
  const startCam = () => {
    camOn = true;
    const img = h("img.camera", { src: `/api/camera?t=${Date.now()}`, alt: "Live view of the printer" });
    img.onerror = () => camWrap.replaceChildren(h("div.camera-off", h("div.big-emoji", "📷"), "The camera is resting", h("button.btn", { type: "button", onclick: startCam }, "Try again")));
    camWrap.replaceChildren(img);
  };
  const stopCam = () => {
    camOn = false;
    const img = camWrap.querySelector("img");
    if (img) {
      img.onerror = null;
      img.removeAttribute("src"); // closes the stream
      img.remove();
    }
  };

  let timer;
  let alive = true;
  const load = async () => {
    try {
      const { printer: p } = await api("/api/printer");
      drawStatus(p);
      if (p.cameraAvailable && f.camera !== false && !camOn && !document.hidden) startCam();
      if (!p.cameraAvailable) camWrap.replaceChildren(h("div.camera-off", h("div.big-emoji", "📷"), "No camera right now"));
    } catch (err) {
      status.replaceChildren(errorCard(err));
    }
    if (alive) timer = setTimeout(load, 3000);
  };

  const drawStatus = (p) => {
    const st = p.online ? p.state : "offline";
    const items = [h("h2", emoji(STATE_EMOJI[st] || "🖨️"), " ", st.charAt(0).toUpperCase() + st.slice(1))];
    if (typeof p.progress === "number") {
      const bar = h("div.progress", h("div"));
      bar.firstChild.style.width = `${Math.max(0, Math.min(100, p.progress))}%`;
      items.push(h("div.progress-label", `${Math.round(p.progress)}%`), bar);
    }
    const stats = [];
    if (p.layer) stats.push(["Layer", `${p.layer[0]} / ${p.layer[1]}`]);
    if (p.temps?.nozzle) stats.push(["Nozzle 🔥", `${Math.round(p.temps.nozzle.current)}° / ${Math.round(p.temps.nozzle.target)}°`]);
    if (p.temps?.bed) stats.push(["Bed", `${Math.round(p.temps.bed.current)}° / ${Math.round(p.temps.bed.target)}°`]);
    if (p.currentFile) stats.push(["File", p.currentFile]);
    if (stats.length) items.push(h("div.stats", stats.map(([k, v]) => h("div.stat", h("span.small", k), h("b", v)))));
    if (p.error) items.push(h("p.small", p.error));
    status.replaceChildren(...items);
    drawControls(p);
  };

  const send = async (cmd, args = {}, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      const r = await api("/api/printer/command", { method: "POST", json: { cmd, args } });
      toast(r.ok ? "Done ✅" : r.message || "The printer said no");
      clearTimeout(timer);
      load();
    } catch (err) {
      toast(err.message);
    }
  };

  const drawControls = (p) => {
    if (!me.user.isAdmin) return controls.replaceChildren();
    const dis = !p.online;
    const locked = !p.controlsEnabled;
    const btn = (icon, label, onclick, extraClass = "", disabled = dis) => h(`button.btn${extraClass}`, { type: "button", disabled, onclick }, emoji(icon), label);
    controls.replaceChildren(
      h("div.card.stack", [
        h("h2", "Grown-up buttons 🛠️"),
        locked ? h("p.small", "Movement and heating buttons are locked until MORPHIX_PRINT_CONTROLS is switched on.") : null,
        h("div.controls", [
          btn("💡", p.light ? "Light off" : "Light on", () => send("light", { on: !p.light })),
          btn("🌀", p.fan ? "Fan off" : "Fan on", () => send("fan", { speed: p.fan ? 0 : 100 }), "", dis || locked),
          btn("🏠", "Home", () => send("home", {}, "Move the printer to its home position?"), "", dis || locked || ["printing", "paused"].includes(p.state)),
          p.state === "paused"
            ? btn("▶️", "Resume", () => send("resume"), "", dis || locked)
            : btn("⏸️", "Pause", () => send("pause"), "", dis || locked || p.state !== "printing"),
          btn("🛑", "Cancel print", () => send("cancel", {}, "Stop this print? It can't be continued."), ".btn-bad", dis || locked || !["printing", "paused"].includes(p.state)),
        ]),
      ]),
    );
  };

  const onVisibility = () => {
    if (document.hidden) return stopCam();
    clearTimeout(timer);
    load();
  };
  document.addEventListener("visibilitychange", onVisibility);
  cleanup = () => {
    alive = false;
    clearTimeout(timer);
    stopCam();
    document.removeEventListener("visibilitychange", onVisibility);
  };
  load();
}

boot();
