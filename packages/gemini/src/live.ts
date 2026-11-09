// Gemini Live over a raw WebSocket (owned by the Electron main process, so the
// API key never reaches the renderer). Push-to-talk: automatic voice activity
// detection is off and each utterance is wrapped in activityStart/activityEnd.
// Input: 16 kHz mono PCM16. Output: 24 kHz mono PCM16 + transcripts.

export const DEFAULT_LIVE_MODEL = "gemini-3.8-live";
const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveCallbacks {
  onAudio(pcm24k: Buffer): void;
  onUserText(text: string): void;
  onAssistantText(text: string): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onToolCall(calls: FunctionCall[]): void;
  onClose(reason: string): void;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: { type: "OBJECT"; properties: Record<string, unknown>; required?: string[] };
}

export class GeminiLive {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private resumeHandle: string | null = null;

  constructor(
    private apiKey: string,
    private model: string,
    private systemInstruction: string,
    private tools: FunctionDeclaration[],
    private cb: LiveCallbacks,
    private voice = "Puck",
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Opens (or reuses) the session; resumes context after a dropped connection. */
  async ensureConnected(timeoutMs = 12000): Promise<void> {
    if (this.connected && this.ready) return this.ready;
    try {
      await this.open(timeoutMs);
    } catch (e) {
      if (!this.resumeHandle) throw e;
      // The old session can't be resumed (e.g. closed for inactivity): start a fresh one.
      this.resumeHandle = null;
      await this.open(timeoutMs);
    }
  }

  private open(timeoutMs: number): Promise<void> {
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.apiKey)}`);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("Gemini did not respond in time"));
        ws.close();
      }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ setup: this.setupMessage() }));
      ws.onmessage = async (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : Buffer.from(await (ev.data as Blob).arrayBuffer()).toString("utf8");
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.setupComplete) {
          clearTimeout(timer);
          resolve();
          return;
        }
        this.handle(msg);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("could not connect to Gemini"));
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = null;
          this.ready = null;
        }
        const reason = ev.reason || `closed (${ev.code})`;
        reject(new Error(`Gemini closed the connection: ${reason}`));
        this.cb.onClose(reason);
      };
    });
    return this.ready;
  }

  setupMessage(): Record<string, unknown> {
    return {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { languageCode: "en-US", voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      },
      systemInstruction: { parts: [{ text: this.systemInstruction }] },
      tools: [{ functionDeclarations: this.tools }],
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };
  }

  private handle(msg: Record<string, any>): void {
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }
    const sc = msg.serverContent;
    if (sc) {
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.cb.onAudio(Buffer.from(part.inlineData.data, "base64"));
      }
      if (sc.inputTranscription?.text) this.cb.onUserText(sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.cb.onAssistantText(sc.outputTranscription.text);
      if (sc.interrupted) this.cb.onInterrupted();
      if (sc.turnComplete) this.cb.onTurnComplete();
    }
    if (msg.toolCall?.functionCalls?.length) {
      this.cb.onToolCall(
        msg.toolCall.functionCalls.map((f: any) => ({ id: String(f.id), name: String(f.name), args: f.args ?? {} })),
      );
    }
  }

  private send(obj: unknown): void {
    if (!this.connected) throw new Error("Gemini is not connected");
    this.ws!.send(JSON.stringify(obj));
  }

  /** Send one complete push-to-talk utterance. */
  sendUtterance(pcm16k: Buffer): void {
    this.send({ realtimeInput: { activityStart: {} } });
    const chunk = 6400; // 200 ms
    for (let o = 0; o < pcm16k.length; o += chunk) {
      this.send({ realtimeInput: { audio: { data: pcm16k.subarray(o, o + chunk).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
    }
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  sendText(text: string): void {
    this.send({ realtimeInput: { text } });
  }

  /** Adds context to the conversation without asking Gemini to reply. */
  addContext(text: string): void {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false } });
  }

  sendToolResponses(responses: { id: string; name: string; response: Record<string, unknown> }[]): void {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }
}

// ---------------------------------------------------------------------------
// What Gemini may ask the app to do. Every call goes through the local policy
// layer in the main process; none of these touch the printer.

export const MORPHIX_TOOLS: FunctionDeclaration[] = [
  {
    name: "offer_engines",
    description: "ALWAYS call this first when the user wants something new made. Shows Meshy / Claude / Open source buttons with your recommendation; then ask the user which one and wait for their answer.",
    parameters: {
      type: "OBJECT",
      properties: {
        request: { type: "STRING", description: "What the user wants, in a few words." },
        recommended: { type: "STRING", enum: ["meshy", "claude", "open_source"], description: "meshy = fun shapes to hold or look at (toys, figures, people, animals, decorations); claude = parts that must fit or work, designed to exact sizes (phone cases, mounts, brackets, gears, replacement parts); open_source = a proven design that probably already exists (robot arms, fidget spinners, multi-part mechanisms)." },
        reason: { type: "STRING", description: "One short sentence: why you recommend it." },
      },
      required: ["request", "recommended", "reason"],
    },
  },
  {
    name: "design_with_claude",
    description: "The user chose Claude: Claude designs the part in CAD (OpenSCAD) to exact sizes. Starts straight away; no Meshy credits. Only after the user picked Claude.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING", description: "Everything Claude needs: the object, the exact device or model it must fit (e.g. iPhone 17), every size the user gave in mm, style details." },
        title: { type: "STRING", description: "Short name for the project, 2-5 words." },
        change_current: { type: "BOOLEAN", description: "true when the user wants to change the model already on screen (\"add a cap to it\", \"make it taller\"): Claude starts from that design." },
      },
      required: ["prompt", "title"],
    },
  },
  {
    name: "search_models",
    description: "Search real free model libraries before Meshy when the request is functional, articulated, multi-part, mechanical, or likely already designed. Shows verified result cards and costs no Meshy credits.",
    parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "Concise search phrase including function and important constraints." } }, required: ["query"] },
  },
  {
    name: "select_searched_model",
    description: "The user picked a Smart Model Search result (by number or name): Morphix downloads every part and opens the model page. Free; nothing prints.",
    parameters: {
      type: "OBJECT",
      properties: {
        number: { type: "NUMBER", description: "Result number as shown (1-5)." },
        id: { type: "STRING", description: "Exact result id returned by search_models (alternative to number)." },
      },
    },
  },
  {
    name: "generate_model",
    description:
      "Propose creating a new 3D model with Meshy. Does NOT start until the user confirms the credit cost. Write a detailed prompt for a single, solid, 3D-printable object.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING", description: "Detailed Meshy text-to-3D prompt (max 600 characters)." },
        title: { type: "STRING", description: "Short name for the project, 2-5 words." },
      },
      required: ["prompt", "title"],
    },
  },
  {
    name: "revise_model",
    description: "Propose a new version of the current model with changes. Also needs user confirmation of the credit cost.",
    parameters: {
      type: "OBJECT",
      properties: { prompt: { type: "STRING", description: "Full updated Meshy prompt including the requested changes." } },
      required: ["prompt"],
    },
  },
  {
    name: "confirm_pending_action",
    description: "Call ONLY right after the user clearly says yes to the pending action's credit cost.",
  },
  { name: "cancel_pending_action", description: "Cancel when the user says no, stop or cancel: clears the action waiting for their OK, the Meshy/Claude/open-source question, and stops a Claude design that is running. Say only what the result says was cancelled." },
  {
    name: "set_model_height",
    description:
      "Resize the current model (always proportionally). Give the size the user said and which dimension it is: height, width, length, or longest (overall size / longest side).",
    parameters: {
      type: "OBJECT",
      properties: {
        value: { type: "NUMBER", description: "Size value." },
        unit: { type: "STRING", enum: ["mm", "cm", "in"], description: "Unit of the size." },
        dimension: {
          type: "STRING",
          enum: ["height", "width", "length", "longest"],
          description: "Which dimension the size refers to. Default height.",
        },
      },
      required: ["value", "unit"],
    },
  },
  { name: "get_app_state", description: "Get the current project, model size, print preparation, printer status, pending action, and credit balance." },
  {
    name: "prepare_print",
    description: "Prepare the current model for printing: repair, orient, slice and estimate time/filament. Free; no confirmation needed.",
    parameters: {
      type: "OBJECT",
      properties: {
        quality: { type: "STRING", enum: ["draft", "normal", "fine"], description: "Layer height: draft 0.28 mm, normal 0.2 mm, fine 0.12 mm." },
        infill_percent: { type: "NUMBER", description: "Infill 5-60 percent. Default 15." },
        supports: { type: "STRING", enum: ["none", "auto", "buildplate"] },
        filament: {
          type: "STRING",
          enum: ["pla", "pla-plus", "petg", "elegoo-rapid-petg", "abs", "asa", "tpu"],
          description: "Only if the user names a material. Default: the filament loaded in the printer (get_app_state loadedFilament).",
        },
      },
    },
  },
  { name: "request_print", description: "The user wants to print the prepared model. Proposes the print; it starts only after the user explicitly confirms." },
  {
    name: "printer_light",
    description: "Turn the printer's light on or off.",
    parameters: { type: "OBJECT", properties: { on: { type: "BOOLEAN" } }, required: ["on"] },
  },
  {
    name: "printer_fan",
    description: "Set the printer's cooling fan speed (0 = off, 100 = full).",
    parameters: { type: "OBJECT", properties: { percent: { type: "NUMBER" } }, required: ["percent"] },
  },
  { name: "home_printer", description: "Move the print head to its home position. Not while printing." },
  {
    name: "set_temperature",
    description: "Heat the nozzle or bed (e.g. to preheat or load filament). Only when the user clearly asks; limits apply.",
    parameters: {
      type: "OBJECT",
      properties: { heater: { type: "STRING", enum: ["nozzle", "bed"] }, celsius: { type: "NUMBER" } },
      required: ["heater", "celsius"],
    },
  },
  { name: "cool_down", description: "Turn both heaters off." },
  { name: "stop_printer", description: "Emergency stop: cancel the print and cool down. Only when the user clearly asks to stop." },
  { name: "pause_print", description: "Pause the running print (always allowed when printer control is enabled)." },
  { name: "cancel_print", description: "Cancel the running print. Ask the user to confirm first in conversation." },
  {
    name: "open_page",
    description: "Show a page on the touchscreen when it helps the user (e.g. Control to change filament, Printer to watch the print).",
    parameters: {
      type: "OBJECT",
      properties: { page: { type: "STRING", enum: ["make", "my_things", "printer", "control"] } },
      required: ["page"],
    },
  },
  {
    name: "load_filament",
    description:
      "Load filament: heats the nozzle for that material, then runs the feeder for about 45 s while the user pushes the filament in. Only when the user asks to load or change filament.",
    parameters: {
      type: "OBJECT",
      properties: { filament: { type: "STRING", enum: ["pla", "pla-plus", "petg", "elegoo-rapid-petg", "abs", "asa", "tpu"], description: "The material being loaded." } },
      required: ["filament"],
    },
  },
  { name: "unload_filament", description: "Unload the filament in the printer: heats the nozzle, then the feeder pulls it out. Only when the user asks." },
  { name: "resume_print", description: "Resume a paused print. Only when the user clearly asks to resume or continue." },
  {
    name: "answer_print_warning",
    description:
      "The user answered a spoken Print Guardian warning. decision stop = they want the print stopped (e.g. 'yes, stop it'); keep_printing = they want it to continue (e.g. 'no, keep printing'). Call it right after their answer.",
    parameters: {
      type: "OBJECT",
      properties: { decision: { type: "STRING", enum: ["stop", "keep_printing"] } },
      required: ["decision"],
    },
  },
];

export const MORPHIX_SYSTEM_INSTRUCTION = `You are Morphix, the friendly voice of an AI 3D printer on a Raspberry Pi touchscreen.
Always speak English. Replies are spoken aloud: keep them to one or two short sentences.

How you work:
- Before making ANYTHING new, call offer_engines and ask the user which of the three to use, saying which you recommend and why:
  • Meshy — fun shapes you hold or look at: characters, people, animals, dragons, Mario, figurines, toys, decorations.
  • Claude — parts that must FIT or WORK, designed to exact sizes in CAD: phone cases (e.g. "iPhone 17 case"), covers, mounts, holders, brackets, hooks, clips, replacement parts, adapters, enclosures, gears, hinges.
  • Open source — a proven free design that probably exists already: robotic arms, fidget spinners, multi-part mechanisms.
  Then wait. Their answer decides: Meshy → generate_model; Claude → design_with_claude; Open source → search_models (include the exact model/size in the query). A plain "yes" means your recommendation. If the user names one themselves ("make it with Claude"), skip the question.
- After search_models: the cards with pictures are on screen. Briefly compare (hardware needed, assembly, print-as-is) and ask which number they want. When they pick, call select_searched_model: it downloads everything and opens the model page. If none fit, offer Meshy only as a fallback; never spend Meshy credits automatically.
- Never invent a model, source link, license, test claim or download. A design is tested/working only when the search result contains supporting evidence; a licence marked "as listed" isn't confirmed.
- If a pick can't be downloaded (e.g. Thingiverse without its key), say so simply and suggest another result; never try to get around a site's login or download limits.
- Imported designs keep every part, their exact size and orientation; they print as build plates holding all the parts. Tell the user which hardware to buy and that the assembly steps are on the model page. Don't suggest resizing functional parts.
- Write Meshy prompts for a single solid printable object: describe shape, pose and style; include a flat stable base; avoid thin fragile parts, floating pieces and text.
- generate_model and revise_model only PROPOSE the job. Tell the user the credit cost from the tool result and ask them to say yes or tap Confirm. Only call confirm_pending_action after they clearly say yes.
- Never say a model is generating or ready unless a tool result or a [Morphix event] message says so.
- When a model is ready, tell the user and ask: "How big would you like it?" Do not ask "what height".
- Sizing is always proportional. If the user names the dimension ("six inches tall", "ten centimetres wide", "four inches long") call set_model_height with that dimension. "Big", "overall" or "longest side" means longest.
- If the user gives a single number without saying which way (e.g. "make it four inches") and the model's width, length and height are clearly different (see get_app_state currentSizeMm), ask one short question: "Four inches tall, wide, or long?" If the shape is roughly as tall as it is wide and long, just use height.
- Prints are sliced for the filament loaded in the printer (get_app_state loadedFilament). If the user wants another material, they change it on the Control tab first.
- To print: call prepare_print first (free), tell the user the estimated time and filament, then call request_print when they want to print. request_print only proposes; the print starts after the user taps Confirm or clearly says yes (then call confirm_pending_action). Relay any "locked" or "not verified" message honestly.
- You can also control the printer's light, fan, home position, heaters and emergency stop with the printer_* tools. Heating and stopping only when the user clearly asks. Some controls may be locked until a grown-up switches them on; say so kindly.
- Many users are children: use simple, friendly words and keep safety first (never encourage touching the hot nozzle or bed).
- Never say the printer started, paused or stopped unless a tool result says it was confirmed by the printer.
- Messages that start with [Morphix event] come from the app, not the user. React to them briefly. One kind tells you which page the user is looking at: use it to help with what's on their screen.
- You can help on every page. If the user asks how to do something, explain it in one or two short steps, offer to do it, and use open_page to show the right page.

How Morphix works (use this to answer "how do I…?" questions):
- Make page: hold the big microphone and describe something, or tap Type it. Meshy builds the 3D model after the user says yes to the credit cost.
- My Things: every model made so far. Open one to see it, pick a size (Tiny 2", Small 3", Medium 4", Big 6", or say a size) and tap Get it ready to print.
- Prepare page: the AI picks the settings (or "I'll choose"), slices for the filament in the printer, and lists any reason it can't print. Then Print it! and Start print.
- Printer page: live camera, time left, Pause print / Resume print / End print, and the Print Guardian, which watches for spaghetti and loose prints and asks out loud whether to stop.
- Control page: Heat (for the loaded filament), Cool down, light, fan, Home, Motors off, Emergency stop, and Filament. Locked while printing, except light and emergency stop; pause first.
- Unloading filament: Control → Unload. The nozzle heats, the feeder pulls the filament back, then pull the end out of the top of the print head. Or ask Morphix to unload it (unload_filament).
- Loading filament: Control → Load filament → pick the material. When the page says the feeder is running, push the filament end into the top of the print head until the motor grabs it and clean plastic comes out of the nozzle. Or ask Morphix (load_filament with the material).
- Morphix can't change filament in the middle of a print (its load/unload runs as a small job, which needs the printer free). Mid-print, pause on the Printer page and use the printer's own Filament menu, then Resume print.
- Never tell anyone to touch the nozzle or bed: they get very hot.
- Messages that start with [Morphix guardian alert] are urgent print warnings from the camera. Say the given warning word for word, nothing else, then wait. When the user answers it, call answer_print_warning straight away (stop or keep_printing) and do not call cancel_print or stop_printer for it. If their answer is unclear, ask once more: "Yes, stop it, or no, keep printing?" Only say the print stopped if the tool result says the printer confirmed it.`;

/** Deterministic check that the user's own words were a clear "yes". */
export function isAffirmative(utterance: string): boolean {
  const t = utterance.toLowerCase();
  if (/\b(no|nope|don'?t|do not|stop|cancel|wait|not (yet|now)|hold on|later|never|but|actually)\b/.test(t)) return false;
  return /\b(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|do it|please do|make it|sounds good|let'?s do it|absolutely)\b/.test(t);
}

/** Converts spoken sizes to millimetres. */
export function toMillimetres(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "in" || u.startsWith("inch")) return value * 25.4;
  if (u === "cm") return value * 10;
  return value;
}
