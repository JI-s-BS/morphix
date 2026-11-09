// Gemini Live voice session + tool handling. Gemini can only REQUEST actions;
// each tool call is checked here against app state and the user's own words.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { IPC, type AssistantTurn, type EngineChoice, type VoiceEvent } from "@morphix/shared";
import {
  GeminiLive, MORPHIX_SYSTEM_INSTRUCTION, MORPHIX_TOOLS, isAffirmative, speechStats, toMillimetres, type FunctionCall,
} from "@morphix/gemini";
import { MM_PER_INCH } from "@morphix/domain";
import { heightForDimension, scaledCheck, stlSize, type SizeDimension } from "@morphix/slicing";
import { type Ctx, latestVersion, moveProject, now } from "./context";
import { type Actions, PolicyError } from "./actions";
import type { Printing } from "./printing";
import type { SmartModelSearch } from "@morphix/model-search";
import { formatDuration } from "./printing";
import { classifyWarningAnswer, type GuardianVoice } from "./guardian-voice";

interface Turn {
  startedAt: number;
  audioBytes: number;
  user: string;
  assistant: string;
  audioRel: string | null;
  /** App-generated event turn (not spoken by the user). */
  system: boolean;
  /** answer_print_warning was handled during this turn. */
  warningHandled?: boolean;
}

export class VoiceController {
  private live: GeminiLive | null = null;
  private turn: Turn | null = null;
  /** The last "Meshy, Claude or open source?" question; creating needs the user's answer to it. */
  private engineOffer: { at: number; recommended: Engine; request: string } | null = null;
  private engineChoiceView: EngineChoice | null = null;
  /** The user's latest words: Gemini often calls tools in a follow-up turn that has none. */
  private lastUser: { text: string; at: number } | null = null;
  /** Recent refusals per tool, to stop Gemini retrying the same refused call in a loop. */
  private refusals = new Map<string, number[]>();
  /** App events waiting for Gemini to finish speaking (see notify). */
  private pendingNotes: string[] = [];
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private balance: { value: number; at: number } | null = null;
  /** Resolves when the next reply audio arrives (guardian warnings). */
  private audioWaiter: (() => void) | null = null;
  /** Drop Gemini audio until the turn ends (a warning that timed out and went to the local voice). */
  private muteUntilTurnEnd = false;
  guardianVoice: GuardianVoice | null = null;
  /** Page on the touchscreen, and the last one Gemini was told about. */
  private page = "assistant";
  private toldPage: string | null = null;

  constructor(
    private ctx: Ctx,
    private actions: Actions,
    private opts: {
      apiKey: string | undefined;
      model: string;
      meshyBalance: () => Promise<number | null>;
      printing: () => Printing | null;
      smartSearch: SmartModelSearch;
      /** Thingiverse API download + import (set by main.ts). */
      downloadSearchResult?: (resultId: string) => Promise<{ parts: string[]; warnings: string[] }>;
      /** Claude + OpenSCAD designer (null until ANTHROPIC_API_KEY is set). */
      claudeCad?: () => ((input: { description: string; title: string; baseScad?: string }) => { jobId: string }) | null;
      /** Stops a running Claude design; returns its title, or null if none was running. */
      stopCad?: () => string | null;
    },
  ) {
    if (opts.apiKey) {
      this.live = new GeminiLive(opts.apiKey, opts.model, MORPHIX_SYSTEM_INSTRUCTION, MORPHIX_TOOLS, {
        onAudio: (pcm) => {
          if (this.muteUntilTurnEnd) return;
          this.audioWaiter?.();
          if (this.turn) this.turn.audioBytes += pcm.length;
          this.emit({ type: "status", state: "speaking" });
          const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
          this.emit({ type: "audio", pcm: ab as ArrayBuffer, sampleRate: 24000 });
        },
        onUserText: (t) => {
          if (this.turn && !this.turn.system) {
            this.turn.user += t;
            this.lastUser = { text: this.turn.user, at: this.turn.startedAt };
            this.emit({ type: "user-text", text: this.turn.user });
          }
        },
        onAssistantText: (t) => {
          if (!this.turn) this.turn = { startedAt: Date.now(), audioBytes: 0, user: "", assistant: "", audioRel: null, system: true };
          this.turn.assistant += t;
          this.emit({ type: "assistant-text", text: this.turn.assistant });
        },
        onInterrupted: () => {
          this.ctx.log.write("info", "gemini interrupted", { system: this.turn?.system ?? null, said: this.turn?.assistant.slice(0, 80) ?? "" });
          this.emit({ type: "interrupted" });
        },
        onTurnComplete: () => {
          this.muteUntilTurnEnd = false;
          this.finishTurn();
        },
        onToolCall: (calls) => void this.handleTools(calls),
        onClose: (reason) => {
          this.toldPage = null; // a new session doesn't know the page yet
          this.ctx.log.write("info", "Gemini session closed", { reason });
          this.emit({ type: "status", state: "idle" });
        },
      });
    }
  }

  get enabled(): boolean {
    return this.live !== null;
  }

  setPage(page: string): void {
    this.page = PAGES[page] ? page : "assistant";
  }

  /** Before the user speaks: make sure Gemini knows which page they're looking at. */
  private tellPage(live: GeminiLive): void {
    if (this.toldPage === this.page) return;
    try {
      const p = PAGES[this.page];
      live.addContext(`[Morphix event] The user is on the ${p.name} page: ${p.about}`);
      this.toldPage = this.page;
    } catch {
      /* best effort */
    }
  }

  /** The user is talking to Morphix right now (a voice turn hasn't finished). */
  get busy(): boolean {
    return Boolean(this.turn && !this.turn.system);
  }

  /** Stop whatever is being said and play the alert chime on the touchscreen. */
  interruptForAlert(): void {
    this.emit({ type: "interrupted" });
    this.emit({ type: "alert" });
  }

  /**
   * Has Gemini say `text` word for word. True only once its audio actually started;
   * false (and any late audio for that turn is dropped) if it can't within the time.
   */
  async speakExact(text: string, opts: { connectMs?: number; audioMs?: number } = {}): Promise<boolean> {
    if (!this.live) return false;
    try {
      if (!this.live.connected) await this.live.ensureConnected(opts.connectMs ?? 5000);
    } catch (e) {
      this.ctx.log.write("warn", "Gemini unavailable for a spoken warning", { error: (e as Error).message });
      return false;
    }
    this.turn = { startedAt: Date.now(), audioBytes: 0, user: "", assistant: "", audioRel: null, system: true };
    this.muteUntilTurnEnd = false;
    const started = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.audioWaiter = null;
        resolve(false);
      }, opts.audioMs ?? 7000);
      this.audioWaiter = () => {
        clearTimeout(timer);
        this.audioWaiter = null;
        resolve(true);
      };
    });
    try {
      this.live.sendText(`[Morphix guardian alert] Say exactly this to the user, word for word, and nothing else, then wait for their answer: "${text}"`);
    } catch (e) {
      this.audioWaiter = null;
      this.ctx.log.write("warn", "could not send the warning to Gemini", { error: (e as Error).message });
      return false;
    }
    const ok = await started;
    if (!ok) this.muteUntilTurnEnd = true; // the local voice takes over; don't talk over it later
    return ok;
  }

  /** Quietly tells Gemini what the backup voice said, so it understands the user's answer. */
  localSpeechContext(text: string): void {
    try {
      if (this.live?.connected) {
        this.live.addContext(`[Morphix guardian alert] The app's backup voice just told the user: "${text}" If the user answers a stop-the-print question, call answer_print_warning.`);
      }
    } catch {
      /* best effort */
    }
  }

  private emit(e: VoiceEvent): void {
    if (e.type === "error") this.ctx.log.write("warn", "voice error shown", { message: e.message });
    this.ctx.send(IPC.voiceEvent, e);
  }

  private async connect(): Promise<GeminiLive> {
    if (!this.live) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
    if (!this.live.connected) this.emit({ type: "status", state: "connecting" });
    await this.live.ensureConnected();
    return this.live;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.connect();
      this.emit({ type: "status", state: "idle" });
      return { ok: true, message: `Connected to ${this.opts.model}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** One push-to-talk utterance (16 kHz PCM16). */
  async utterance(pcm: Buffer, audioRel: string | null): Promise<void> {
    const { rms, peak, seconds } = speechStats(pcm, 16000);
    this.ctx.log.write("info", "voice turn", { seconds: Math.round(seconds * 10) / 10, rms: Math.round(rms * 1000) / 1000, peak: Math.round(peak * 100) / 100 });
    if (seconds < 0.4 || (rms < 0.006 && peak < 0.04)) {
      this.ctx.log.write("warn", "voice turn too quiet", { seconds, rms, peak });
      this.emit({ type: "error", message: "I didn't catch that. Hold the button and speak a little closer to the mic." });
      return;
    }
    const live = await this.connect();
    this.turn = { startedAt: Date.now(), audioBytes: 0, user: "", assistant: "", audioRel, system: false };
    this.emit({ type: "status", state: "thinking" });
    this.tellPage(live);
    live.sendUtterance(pcm);
  }

  async text(text: string): Promise<void> {
    const t = text.trim().slice(0, 500);
    if (!t) return;
    const live = await this.connect();
    this.turn = { startedAt: Date.now(), audioBytes: 0, user: t, assistant: "", audioRel: null, system: false };
    this.lastUser = { text: t, at: this.turn.startedAt };
    this.emit({ type: "user-text", text: t });
    this.emit({ type: "status", state: "thinking" });
    this.tellPage(live);
    live.sendText(t);
  }

  /** Tell Gemini about something the app did (it reacts out loud). */
  async notify(message: string): Promise<void> {
    if (!this.live?.connected) return;
    // Sending while Gemini is answering (or the user is talking) cuts Gemini off mid-sentence:
    // hold app events until that turn is over (at most 20 s), then send them together.
    if (this.turn) {
      this.pendingNotes.push(message);
      if (this.pendingNotes.length > 5) this.pendingNotes.shift();
      this.noteTimer ??= setTimeout(() => {
        this.noteTimer = null;
        this.flushNotes(true);
      }, 20_000);
      return;
    }
    this.sendNote(message);
  }

  private sendNote(message: string): void {
    if (!this.live?.connected) return;
    this.turn = { startedAt: Date.now(), audioBytes: 0, user: "", assistant: "", audioRel: null, system: true };
    try {
      this.live.sendText(`[Morphix event] ${message}`);
    } catch (e) {
      this.ctx.log.write("warn", "notify failed", { error: (e as Error).message });
    }
  }

  /** Sends held app events once Gemini has finished its turn (or `force` after the timeout). */
  private flushNotes(force = false): void {
    if (!this.pendingNotes.length || (this.turn && !force)) return;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    const notes = this.pendingNotes.splice(0);
    this.sendNote(notes.length === 1 ? notes[0] : `Several things happened: ${notes.map((n, i) => `(${i + 1}) ${n}`).join(" ")}`);
  }

  private finishTurn(): void {
    const turn = this.turn;
    this.turn = null;
    this.emit({ type: "status", state: "idle" });
    if (!turn) return;
    this.ctx.log.write("info", "voice reply", {
      system: turn.system, heard: turn.user.slice(0, 120), said: turn.assistant.slice(0, 160),
      replyAudioSeconds: Math.round((turn.audioBytes / 48000) * 10) / 10, ms: Date.now() - turn.startedAt,
    });
    const save = (role: "user" | "assistant", text: string, audioRel: string | null): AssistantTurn | null => {
      if (!text.trim()) return null;
      const row = { id: randomUUID(), role, text: text.trim(), createdAt: now() };
      this.ctx.db.run("INSERT INTO conversation(id, role, text, audio_rel_path, created_at) VALUES (?,?,?,?,?)", [
        row.id, role, row.text, audioRel, row.createdAt,
      ]);
      return { ...row, audioUrl: this.ctx.url(audioRel) ?? undefined };
    };
    const user = turn.system ? null : save("user", turn.user || "(voice message)", turn.audioRel);
    const assistant = save("assistant", turn.assistant, null);
    this.emit({ type: "turn-complete", user, assistant });
    if (this.pendingNotes.length) setTimeout(() => this.flushNotes(), 250);
    // Backup for a print warning: act on a clear spoken answer even if Gemini didn't call the tool.
    const gv = this.guardianVoice;
    if (!turn.system && !turn.warningHandled && gv?.open) {
      const decision = classifyWarningAnswer(turn.user);
      if (decision) {
        this.ctx.log.write("info", "print warning answered by voice (app matched the words)", { heard: turn.user.slice(0, 80), decision });
        void gv.answer(decision, "voice", true);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Tool policy

  private async handleTools(calls: FunctionCall[]): Promise<void> {
    const responses = [];
    for (const c of calls) {
      let response: Record<string, unknown>;
      const recent = (this.refusals.get(c.name) ?? []).filter((t) => Date.now() - t < 20_000);
      if (recent.length >= 3) {
        response = { ok: false, error: "STOP: this was refused several times just now. Don't call any tool again yet: tell the user in one short sentence what's needed and wait for them to answer." };
        if (recent.length === 3) this.ctx.log.write("warn", `tool ${c.name} loop stopped`, { refusals: recent.length });
        this.refusals.set(c.name, [...recent, Date.now()]);
        responses.push({ id: c.id, name: c.name, response });
        continue;
      }
      try {
        response = await this.tool(c);
      } catch (e) {
        response = { ok: false, error: (e as Error).message };
      }
      if (response.ok === false) this.refusals.set(c.name, [...recent, Date.now()]);
      else this.refusals.delete(c.name);
      this.ctx.log.write("info", `tool ${c.name}`, { args: c.args, ok: response.ok !== false });
      responses.push({ id: c.id, name: c.name, response });
    }
    try {
      this.live?.sendToolResponses(responses);
    } catch (e) {
      this.ctx.log.write("error", "tool response failed", { error: (e as Error).message });
    }
  }

  private async credits(): Promise<number | null> {
    if (this.balance && Date.now() - this.balance.at < 60_000) return this.balance.value;
    const v = await this.opts.meshyBalance().catch(() => null);
    if (v !== null) this.balance = { value: v, at: Date.now() };
    return v;
  }

  /**
   * Creating anything needs the user's own pick of Meshy, Claude or open source: either they
   * named it this turn, or they answered an offer_engines question asked in an earlier turn.
   */
  /** The open "Meshy, Claude or open source?" question, for the phone (null once answered or stale). */
  get engineChoice(): EngineChoice | null {
    return this.engineOffer && Date.now() - this.engineOffer.at < 15 * 60_000 ? this.engineChoiceView : null;
  }

  /** OpenSCAD of the current model when Claude designed it (saved next to its STL), else null. */
  private currentScad(): string | null {
    const v = latestVersion(this.ctx, this.ctx.currentProjectId);
    if (!v || v.source !== "openscad" || !v.stl_rel_path) return null;
    try {
      return this.ctx.storage.read(join(dirname(this.ctx.storage.path(String(v.stl_rel_path))), "model.scad")).toString("utf8");
    } catch {
      return null;
    }
  }

  /** The user picked: hide the buttons (touchscreen and phone). */
  private engineAnswered(): void {
    this.engineOffer = null;
    this.engineChoiceView = null;
    this.ctx.event({ type: "engine-choice", choice: null });
  }

  private engineGate(engine: Engine): Record<string, unknown> | null {
    // The user's words: this turn's, or (in Gemini's follow-up turns) their latest within 2 min.
    const own = this.turn && !this.turn.system && this.turn.user ? { text: this.turn.user, at: this.turn.startedAt } : null;
    const last = own ?? (this.lastUser && Date.now() - this.lastUser.at < 120_000 ? this.lastUser : null);
    const said = last?.text ?? "";
    if (ENGINE_WORDS[engine].test(said)) return null;
    const offer = this.engineOffer;
    const answered = offer && Date.now() - offer.at < 15 * 60_000 && (last?.at ?? 0) > offer.at;
    // A plain "yes" picks the recommended one; another engine has to be named.
    const namedOther = ENGINES.some((e) => e !== engine && ENGINE_WORDS[e].test(said));
    if (answered && !namedOther && engine === offer.recommended) return null;
    if (answered) return { ok: false, error: `The user didn't pick ${ENGINE_NAME[engine]}. Use the one they chose (a plain yes means ${ENGINE_NAME[offer.recommended]}).` };
    return {
      ok: false,
      error: offer && !answered
        ? "Wait for the user to answer which one they want (Meshy, Claude or open source) before creating anything."
        : "Before creating anything, call offer_engines: ask the user whether to use Meshy, Claude or an open-source design, and say which you recommend and why.",
    };
  }

  private async tool(c: FunctionCall): Promise<Record<string, unknown>> {
    const a = c.args;
    switch (c.name) {
      case "offer_engines": {
        const recommended = (ENGINES as readonly string[]).includes(String(a.recommended)) ? (String(a.recommended) as Engine) : "meshy";
        const request = String(a.request ?? "").slice(0, 300);
        const claude = this.opts.claudeCad?.() != null;
        this.engineOffer = { at: Date.now(), recommended, request };
        this.ctx.event({ type: "navigate", page: "assistant" });
        this.engineChoiceView = { request, recommended, reason: String(a.reason ?? "").slice(0, 300), claudeAvailable: claude, at: new Date().toISOString() };
        this.ctx.event({ type: "engine-choice", choice: this.engineChoiceView });
        return {
          ok: true,
          note: `Choice buttons (Meshy / Claude / Open source) are on screen with ${ENGINE_NAME[recommended]} marked as recommended. Ask the user which one in one short sentence and say why you recommend it; then wait for their answer before calling any creation tool.${claude ? "" : " Claude isn't switched on yet (no ANTHROPIC_API_KEY): say so if they pick it."}`,
        };
      }
      case "design_with_claude": {
        const gate = this.engineGate("claude");
        if (gate) return gate;
        const design = this.opts.claudeCad?.();
        if (!design) return { ok: false, error: "Claude isn't switched on yet: ANTHROPIC_API_KEY is missing from ~/Morphix/config/morphix.env. Tell the user and offer Meshy or an open-source design instead." };
        // "Add a cap to it": give Claude the design on screen so it changes that one.
        const base = a.change_current === true ? this.currentScad() : null;
        const r = design({ description: String(a.prompt ?? ""), title: String(a.title ?? ""), baseScad: base ?? undefined });
        this.engineAnswered();
        return {
          ok: true, status: "designing", jobId: r.jobId,
          note: `${a.change_current === true && !base ? "The model on screen isn't a Claude design, so Claude is making a new one from scratch: tell the user. " : base ? "Claude is changing the design on screen. " : ""}Claude is designing it now (usually 1-5 minutes; no Meshy credits). Progress is on screen. Don't say it's ready until a [Morphix event] says so.`,
        };
      }
      case "search_models": {
        const gate = this.engineGate("open_source");
        if (gate) return gate;
        this.ctx.event({ type: "navigate", page: "assistant" });
        this.engineAnswered();
        const state = await this.opts.smartSearch.search(String(a.query ?? ""));
        return state.status === "ready"
          ? {
              ok: true,
              count: state.results.length,
              results: state.results.map((r, i) => ({
                number: i + 1, id: r.id, name: r.name, site: r.source,
                license: r.license ? `${r.license}${r.licenseVerified ? "" : " (as listed, not confirmed on the page)"}` : "not stated — check the page",
                printedParts: r.parts, needsHardware: r.nonPrintedParts, printAsIs: r.printAsIs,
                printEvidence: r.evidence.length ? r.evidence : "none found — don't call it tested or proven",
                download: r.download === "thingiverse-api" ? "Morphix can download it (Thingiverse)" : "download it from its page, then import",
              })),
              note: "The real result cards (pictures, links, QR codes) are on the Make screen now. Briefly compare them (hardware needed, assembly, print-as-is), then ask which number they want. Don't propose Meshy unless they ask or none fit.",
            }
          : { ok: false, error: state.error, fallback: "Say nothing suitable was found and offer to make one with Meshy (credits only after they say yes)." };
      }
      case "select_searched_model": {
        // Choosing a design gets it straight away: download every part and open the model page.
        const st = this.opts.smartSearch.state;
        const n = Number(a.number);
        const id = String(a.id ?? "") || (Number.isInteger(n) && st?.results[n - 1] ? st.results[n - 1].id : "");
        const result = this.opts.smartSearch.select(id);
        try {
          const r = await this.opts.downloadSearchResult?.(id);
          if (!r) return { ok: false, message: "Downloading isn't available." };
          return {
            ok: true, name: result.name, parts: r.parts, needsHardware: result.nonPrintedParts, warnings: r.warnings.slice(0, 4),
            note: "Every part is downloaded and the model page is on screen (parts, hardware, assembly). It keeps its original size. Nothing is printing yet: they tap Get it ready to print when ready.",
          };
        } catch (e) {
          return { ok: false, name: result.name, message: (e as Error).message, note: "Explain simply and offer another result." };
        }
      }
      case "generate_model": {
        // Things that must fit or work come from real designs first, not Meshy.
        const words = `${this.turn?.user ?? ""} ${String(a.prompt ?? "")} ${String(a.title ?? "")}`;

        const gate = this.engineGate("meshy");
        if (gate) return gate;
        const askedForAi = /\b(meshy|ai[- ]?(made|generated|make)|generate (it|one) anyway|make (one|it) up|your own design)\b/i.test(this.turn?.user ?? "") || this.engineOffer?.recommended === "meshy";
        const searchedRecently = Date.now() - this.opts.smartSearch.lastFinishedAt < 15 * 60_000;
        if (needsRealDesign(words) && !askedForAi && !searchedRecently) {
          return { ok: false, error: "This has to fit or work (exact sizes or moving parts), so Meshy is the wrong tool: use design_with_claude or search_models (whichever the user picked). Use Meshy only if the user asks for it by name." };
        }
        const p = this.actions.proposeGenerate(String(a.prompt ?? ""), String(a.title ?? ""));
        this.engineAnswered();
        return { ok: true, status: "awaiting_user_confirmation", credits: p.credits, balance: await this.credits(), note: "Ask the user to say yes or tap Confirm." };
      }
      case "revise_model": {
        const pid = this.ctx.currentProjectId;
        if (!pid) throw new PolicyError("there is no current model to revise");
        const title = String(this.ctx.db.get("SELECT title FROM projects WHERE id = ?", [pid])?.title ?? "model");
        const p = this.actions.proposeGenerate(String(a.prompt ?? ""), title, pid);
        return { ok: true, status: "awaiting_user_confirmation", credits: p.credits, balance: await this.credits() };
      }
      case "confirm_pending_action": {
        const pending = this.actions.current;
        if (!pending) return { ok: false, error: "nothing is waiting for confirmation" };
        const words = this.turn?.user ?? "";
        if (this.turn?.system || !isAffirmative(words)) {
          return { ok: false, error: "The user has not clearly said yes. Ask them to say yes or tap Confirm on the screen." };
        }
        const r = this.actions.confirm(pending.id, "voice");
        if (r.printing) {
          r.printing.then(
            () => void this.notify("The printer confirmed the print has started. Tell the user briefly; the camera guardian is watching it."),
            (e) => void this.notify(`Starting the print failed: ${(e as Error).message}. Tell the user plainly.`),
          );
          return { ok: true, status: "sending_to_printer", note: "Not printing yet: wait for the [Morphix event] that the printer confirmed." };
        }
        return { ok: true, status: "started", kind: pending.kind, credits: pending.credits, projectId: r.projectId, note: "Generation takes about one to three minutes." };
      }
      case "cancel_pending_action": {
        const pending = this.actions.current;
        this.actions.clear();
        const offered = this.engineOffer !== null;
        if (offered) this.engineAnswered();
        const stopped = this.opts.stopCad?.() ?? null;
        const done = [pending ? `the pending ${pending.kind ?? "action"}` : "", offered ? "the Meshy/Claude/open-source question" : "", stopped ? `Claude's design of "${stopped}"` : ""].filter(Boolean);
        if (!done.length) return { ok: false, error: "Nothing was waiting or being designed, so nothing was cancelled. A Meshy model that is already generating can't be stopped (its credits are spent). Tell the user exactly that." };
        return { ok: true, cancelled: done };
      }
      case "set_model_height": {
        const sizeMm = toMillimetres(Number(a.value), String(a.unit ?? "mm"));
        const dimension: SizeDimension = ["width", "length", "longest"].includes(String(a.dimension)) ? (String(a.dimension) as SizeDimension) : "height";
        const v = latestVersion(this.ctx, this.ctx.currentProjectId);
        if (!v) throw new PolicyError("there is no current model");
        const native = this.nativeSize(String(v.stl_rel_path ?? ""));
        const mm = dimension === "height" || !native ? sizeMm : heightForDimension(native, dimension, sizeMm);
        if (!(mm >= 5 && mm <= 600)) throw new PolicyError("that size would make the model between 5 mm and 600 mm tall only; pick another size");
        this.ctx.db.run("UPDATE model_versions SET target_height_mm = ? WHERE id = ?", [Math.round(mm * 10) / 10, v.id]);
        try {
          moveProject(this.ctx, String(v.project_id), "sizing");
        } catch {
          /* keep current state */
        }
        this.ctx.event({ type: "navigate", page: "viewer", projectId: String(v.project_id) });
        this.ctx.event({ type: "model-height", versionId: String(v.id), heightMm: mm });
        const size = this.sizeOf(String(v.stl_rel_path ?? ""), mm);
        return {
          ok: true, dimension, heightMm: Math.round(mm), heightInches: Math.round((mm / MM_PER_INCH) * 10) / 10,
          ...(size ? { widthMm: Math.round(size.size.x), depthMm: Math.round(size.size.y), fitsPrinter: size.fits, buildVolumeMm: size.volume } : {}),
        };
      }
      case "get_app_state": {
        const pid = this.ctx.currentProjectId;
        const project = pid ? this.ctx.db.get("SELECT title, state FROM projects WHERE id = ?", [pid]) : undefined;
        const v = latestVersion(this.ctx, pid);
        const target = v?.target_height_mm == null ? null : Number(v.target_height_mm);
        const size = v ? this.sizeOf(String(v.stl_rel_path ?? ""), target) : null;
        return {
          ok: true,
          project: project ? { title: project.title, state: project.state, modelKind: v?.kind ?? null } : null,
          targetHeightMm: target,
          currentSizeMm: size ? { width: Math.round(size.size.x), length: Math.round(size.size.y), height: Math.round(size.size.z) } : null,
          fitsPrinter: size?.fits ?? null,
          printWarning: this.guardianVoice?.view() ?? null,
          loadedFilament: this.opts.printing()?.loadedFilament() ?? null,
          filaments: this.opts.printing()?.filaments().list.map((f) => `${f.id} (${f.label}: nozzle ${f.nozzleC}°C, bed ${f.bedC}°C)`) ?? [],
          currentPage: PAGES[this.page]?.name ?? this.page,
          pendingAction: this.actions.current ? { kind: this.actions.current.kind, credits: this.actions.current.credits } : null,
          meshyCredits: await this.credits(),
          print: (() => {
            const printing = this.opts.printing();
            if (!printing) return null;
            const st = printing.status();
            const job = pid ? printing.latest(pid) : null;
            return { controlsEnabled: st.enabled, gxVerified: st.gxVerified, activeJob: st.job, prepared: job ? { ok: job.ok, fits: job.fits, estimates: job.estimates } : null };
          })(),
        };
      }
      case "prepare_print": {
        const printing = this.opts.printing();
        const v = latestVersion(this.ctx, this.ctx.currentProjectId);
        if (!printing || !v) throw new PolicyError("there is no current model to prepare");
        const layer = a.quality === "draft" ? 0.28 : a.quality === "fine" ? 0.12 : 0.2;
        const infill = Math.min(60, Math.max(5, Number(a.infill_percent ?? 15)));
        const supports = ["none", "auto", "buildplate"].includes(String(a.supports)) ? (String(a.supports) as "none" | "auto" | "buildplate") : "auto";
        this.ctx.event({ type: "navigate", page: "prepare", projectId: String(v.project_id) });
        const filament = typeof a.filament === "string" ? a.filament : undefined;
        const r = await printing.prepare(String(v.id), { layerHeightMm: layer, infillPercent: infill, supports, filament });
        return {
          ok: r.ok, jobId: r.jobId, fits: r.fits, sizeMm: r.size ? [Math.round(r.size.x), Math.round(r.size.y), Math.round(r.size.z)] : null,
          printTime: r.estimates?.printTimeS ? formatDuration(r.estimates.printTimeS) : null,
          filamentGrams: r.estimates?.filamentG ? Math.round(r.estimates.filamentG) : null,
          estimateSource: r.estimates?.source, slicer: r.slicer.ok ? "ok" : r.slicer.message, warnings: r.warnings.slice(0, 3), error: r.error,
        };
      }
      case "request_print": {
        const printing = this.opts.printing();
        const pid = this.ctx.currentProjectId;
        const job = printing && pid ? printing.latest(pid) : null;
        if (!job) return { ok: false, message: "Prepare the model first (prepare_print)." };
        const p = this.actions.proposePrint(job.jobId);
        return { ok: true, status: "awaiting_user_confirmation", file: p.fileName, details: p.details, note: "Ask the user to tap Confirm or say yes." };
      }
      case "printer_light":
      case "printer_fan":
      case "home_printer":
      case "set_temperature":
      case "cool_down":
      case "stop_printer": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        if (c.name === "stop_printer" && (this.turn?.system || !/\b(stop|cancel|abort|emergency)\b/i.test(this.turn?.user ?? ""))) {
          return { ok: false, message: "Only stop when the user clearly asks to stop." };
        }
        if (c.name === "set_temperature" && this.turn?.system) return { ok: false, message: "Only heat when the user asks." };
        const cmd =
          c.name === "printer_light" ? { cmd: "light" as const, on: Boolean(a.on) }
          : c.name === "printer_fan" ? { cmd: "fan" as const, percent: Number(a.percent ?? 100) }
          : c.name === "home_printer" ? { cmd: "home" as const }
          : c.name === "cool_down" ? { cmd: "cooldown" as const }
          : c.name === "stop_printer" ? { cmd: "stop" as const }
          : { cmd: (a.heater === "bed" ? "bed" : "nozzle") as "bed" | "nozzle", celsius: Number(a.celsius) };
        return await printing.machine(cmd, "voice");
      }
      case "pause_print": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        return await printing.pause();
      }
      case "cancel_print": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        if (this.turn?.system || !/\b(cancel|stop|abort)\b/i.test(this.turn?.user ?? "")) {
          return { ok: false, message: "Only cancel when the user clearly asks to cancel or stop the print." };
        }
        return await printing.cancel();
      }
      case "open_page": {
        const target = { make: "assistant", my_things: "library", printer: "printer", control: "control" }[String(a.page)] as
          | "assistant" | "library" | "printer" | "control" | undefined;
        if (!target) return { ok: false, error: "unknown page (make, my_things, printer, control)" };
        this.ctx.event({ type: "navigate", page: target });
        this.page = target;
        this.toldPage = target;
        return { ok: true, page: PAGES[target].name, shows: PAGES[target].about };
      }
      case "load_filament":
      case "unload_filament": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        if (!this.turn || this.turn.system || !/\b(load|unload|change|swap|switch|put|take|remove|feed|pull)\b/i.test(this.turn.user)) {
          return { ok: false, message: "Only when the user asks to load, unload or change the filament. Explain the steps instead." };
        }
        const kind = c.name === "load_filament" ? "load" : "unload";
        this.ctx.event({ type: "navigate", page: "control" });
        const r = await printing.filamentJob(kind, kind === "load" ? String(a.filament ?? "") : undefined);
        return {
          ...r,
          note: r.ok
            ? kind === "load"
              ? "Tell the user: the nozzle is heating; when the Control page says the feeder is running, push the filament end into the top of the print head until the motor grabs it."
              : "Tell the user: the nozzle is heating, then the feeder pulls the filament out; pull the end out of the top when it stops."
            : "Explain why plainly and offer to help.",
        };
      }
      case "resume_print": {
        const printing = this.opts.printing();
        if (!printing) throw new PolicyError("printing is not available");
        if (!this.turn || this.turn.system || !/\b(resume|continue|carry on|keep going|unpause|start (it )?again)\b/i.test(this.turn.user)) {
          return { ok: false, message: "Only resume when the user clearly asks to." };
        }
        return await printing.resume("voice");
      }
      case "answer_print_warning": {
        const gv = this.guardianVoice;
        if (!gv?.open) return { ok: false, error: "No print warning is waiting for an answer." };
        if (!this.turn || this.turn.system) return { ok: false, error: "Only the user's own spoken answer counts." };
        const wanted = a.decision === "stop" ? "stop" : a.decision === "keep_printing" ? "keep" : null;
        const heard = classifyWarningAnswer(this.turn.user);
        if (!wanted || heard !== wanted) {
          return { ok: false, error: "The user's answer was not clear. Ask once more: yes, stop it, or no, keep printing?", heard: this.turn.user.slice(0, 80) };
        }
        this.turn.warningHandled = true;
        const r = await gv.answer(wanted, "voice", false);
        return {
          ok: r.ok, stopped: r.stopped ?? false, message: r.message,
          note: wanted === "keep" ? "Tell the user you'll keep printing and keep watching." : r.ok ? "Say exactly what message says." : "The printer did NOT confirm. Tell the user to press stop on the printer's screen.",
        };
      }
      default:
        return { ok: false, error: `unknown tool ${c.name}` };
    }
  }

  private nativeSize(stlRel: string) {
    if (!stlRel) return null;
    try {
      return stlSize(this.ctx.storage.read(this.ctx.storage.path(stlRel)));
    } catch {
      return null;
    }
  }

  private sizeOf(stlRel: string, targetMm: number | null) {
    if (!stlRel) return null;
    try {
      const native = stlSize(this.ctx.storage.read(this.ctx.storage.path(stlRel)));
      return native ? scaledCheck(native, targetMm) : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.live?.close();
  }
}

/** What each touchscreen page is for (told to Gemini so it can help with what's on screen). */
const PAGES: Record<string, { name: string; about: string }> = {
  assistant: { name: "Make", about: "the big microphone button and the chat; describe something to make, or tap Type it." },
  library: { name: "My Things", about: "every model made so far; tap one to open it." },
  viewer: { name: "model", about: "a 3D preview of one model with its size and How big buttons (Tiny 2\", Small 3\", Medium 4\", Big 6\"), and Get it ready to print." },
  prepare: { name: "Prepare", about: "print settings (Let the AI choose / I'll choose), the Filament in the printer picker, what the slicer found, why it can't print if it can't, and Print it!." },
  printer: { name: "Printer", about: "the live camera, the running print with time left, Pause print / Resume print / End print, the Print Guardian and the printer status." },
  control: { name: "Control", about: "heat (Heat for the loaded filament, nozzle only, bed only, Cool down), Filament (Unload / Load filament), light, fan, Home, Motors off and Emergency stop. Locked while a print runs, except light and emergency stop." },
  settings: { name: "Grown-ups", about: "settings: look (dark/light), AI keys status, web portal, Morphix Remote pairing, storage, Test speaker, Test the print warning and the log." },
};

/**
 * Requests that have to fit something real or work mechanically: phone cases, mounts,
 * brackets, replacement parts, gears, hinges, robot arms, spinners, enclosures… Meshy makes
 * shapes, not measured parts, so these go to Smart Model Search first.
 */
export const ENGINES = ["meshy", "claude", "open_source"] as const;
export type Engine = (typeof ENGINES)[number];
const ENGINE_NAME: Record<Engine, string> = { meshy: "Meshy", claude: "Claude", open_source: "an open-source design" };
/** The user naming an engine themselves counts as choosing it. */
export const ENGINE_WORDS: Record<Engine, RegExp> = {
  meshy: /\bmeshy\b/i,
  claude: /\b(claude|cad)\b/i,
  open_source: /\b(open[- ]?source|search|find (me )?(one|a design|it)|thingiverse|github|existing design)\b/i,
};

export function needsRealDesign(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(i?phone|galaxy|pixel|airpods?|ipad|tablet|laptop|phone case|case for|cover for|mount|bracket|holder|hook|clip|clamp|hinge|gears?|cog|bearings?|fidget spinner|spinner|robotic arm|robot arm|robotic|gripper|replacement|spare part|adapter|connector|enclosure|housing|knob|screw|bolt|spool holder|organi[sz]er|stand for|dock|charger|joint|articulated|moving parts|working|functional|wrench|box with (a )?lid|hinged|latch)\b/.test(t);
}
