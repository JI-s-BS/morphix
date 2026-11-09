// Smart Model Search results on the touchscreen: real designs with their picture, licence,
// hardware and print-as-is facts, and one button — "Choose this one" — which downloads every
// part, imports it and opens the model page. Never starts Meshy or a print.
import { useEffect, useState } from "react";
import type { SmartSearchState } from "@morphix/shared";
import { api } from "../bridge";
import { friendlyError } from "../errors";

const SITE: Record<string, string> = { printables: "Printables", thingiverse: "Thingiverse", makerworld: "MakerWorld", github: "GitHub", other: "Model library" };

export function SearchResults({ onOpenProject, onError }: { onOpenProject: (id: string) => void; onError: (m: string) => void }) {
  const [search, setSearch] = useState<SmartSearchState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  /** Result whose phone QR code is open (Thingiverse designs without a token). */
  const [phoneFor, setPhoneFor] = useState<string | null>(null);

  useEffect(() => {
    api.smartSearchState().then(setSearch).catch(() => {});
    return api.onAppEvent((e) => {
      if (e.type === "smart-search") setSearch(e.state);
    });
  }, []);

  if (!search) return null;
  if (search.status === "searching") return <div className="bubble assistant">🔎 Looking for real designs for “{search.query}”…</div>;
  if (search.status === "failed") return <div className="bubble assistant" style={{ color: "var(--bad)" }}>{search.error}</div>;

  const choose = async (id: string) => {
    setBusy(id);
    setProblem(null);
    try {
      const out = await api.downloadSmartModel(id);
      onOpenProject(out.projectId);
    } catch (e) {
      const f = friendlyError(e); // "MX-…|title|hint|detail" → the readable part
      const message = f.detail?.trim() || f.title;
      setProblem({ id, message });
      onError(message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="search-results">
      <div className="muted small">Real designs for “{search.query}” — tap the one you want.</div>
      {search.results.map((r, i) => {
        const img = r.thumbUrl || r.imageUrl;
        return (
          <div key={r.id} className={`bubble assistant search-card ${search.selectedId === r.id ? "chosen" : ""}`}>
            {img ? <img className="search-hero" src={img} alt={r.name} /> : <div className="search-hero search-noimg">🧩</div>}
            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
              <div className="search-num">{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b className="search-name">{r.name}</b>
                <div className="muted small">
                  {SITE[r.source]}{r.creator ? ` · by ${r.creator}` : ""} · {r.license ? `${r.license}${r.licenseVerified ? " ✓" : " (as listed)"}` : "licence: check the page"}
                </div>
              </div>
            </div>
            <div className="small" style={{ marginTop: 6 }}>{r.description}</div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <span className={`chip ${r.printAsIs ? "" : "warn-chip"}`}>{r.printAsIs ? "✅ Prints as-is" : "🔧 Needs assembly"}</span>
              {r.nonPrintedParts.length > 0 && <span className="chip">Needs: {r.nonPrintedParts.join(", ")}</span>}
              {(r.files.length || r.parts.length) > 0 && <span className="chip">{r.files.length || r.parts.length} part{(r.files.length || r.parts.length) === 1 ? "" : "s"}</span>}
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>{r.evidence.length ? `Printed by others: ${r.evidence.join("; ")}` : "No print reports found yet."}</div>
            {r.download === "needs-key" ? (
              <>
                <button className="btn primary search-choose" onClick={() => setPhoneFor(phoneFor === r.id ? null : r.id)}>
                  {phoneFor === r.id ? "Hide the code" : `📱 Get this one on my phone (${i + 1})`}
                </button>
                {phoneFor === r.id && (
                  <div className="search-phone">
                    {r.qrDataUrl && <img src={r.qrDataUrl} alt={`QR code for ${r.pageUrl}`} />}
                    <div className="small">
                      Scan with your phone camera (or open <b>{r.pageUrl.replace(/^https:\/\/(www\.)?/, "")}</b>), tap <b>Download</b>, then send the files to Morphix.
                      Thingiverse only lets apps download files with a Thingiverse app token.
                    </div>
                  </div>
                )}
              </>
            ) : (
              <button className="btn primary search-choose" disabled={busy !== null} onClick={() => void choose(r.id)}>
                {busy === r.id ? "Getting all the parts…" : `Choose this one (${i + 1})`}
              </button>
            )}
            {problem?.id === r.id && <div className="small" style={{ color: "var(--bad)", marginTop: 6 }}>{problem.message}</div>}
          </div>
        );
      })}
      {search.more && <div className="bubble assistant">🔎 Finding more designs…</div>}
      <div className="muted small">None of these right? Ask me to make one with Meshy instead (it uses credits only after you say yes).</div>
    </div>
  );
}
