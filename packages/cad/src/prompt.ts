// Prompts for Claude: one stable system prompt (printer + OpenSCAD rules) and a per-
// request user prompt that carries the description, known device dimensions and the
// failures of earlier attempts.
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import { describeDevice, isFitCritical, mentionsDevice, type DeviceDimensions } from "./devices";

export const MAX_FN_HINT = 64;

/** Structured output schema: Claude answers with exactly this object. */
export const CAD_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scad", "sizeMm", "assumptions", "notes"],
  properties: {
    scad: { type: "string", description: "Complete OpenSCAD source." },
    sizeMm: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z"],
      properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
      description: "Expected bounding box of the rendered part in mm.",
    },
    assumptions: { type: "array", items: { type: "string" }, description: "Every measurement or fact assumed rather than given, with numbers." },
    notes: { type: "array", items: { type: "string" }, description: "Short printing/assembly notes for the user." },
  },
} as const;

export interface CadAnswer {
  scad: string;
  sizeMm: { x: number; y: number; z: number };
  assumptions: string[];
  notes: string[];
}

export interface CadPromptInput {
  description: string;
  dimensions?: Record<string, number>;
  photoAnalysis?: unknown;
  device?: DeviceDimensions | null;
  /** The current design's OpenSCAD, when the user asked to change it ("add a cap to it"). */
  baseScad?: string;
}

export interface FailedAttempt {
  attempt: number;
  scad: string;
  problem: string;
}

const V = QD330_BUILD_VOLUME_MM;

export const CAD_SYSTEM_PROMPT = [
  "You are a mechanical design engineer who writes parametric OpenSCAD for FDM 3D printing.",
  "Your models are rendered headlessly by OpenSCAD 2021.01 and printed without human CAD review, so they must compile and print first time.",
  "",
  "Printer: Afinia QD330, PLA, 0.4 mm nozzle, 0.2 mm layers.",
  `Build volume: ${V.x} x ${V.y} x ${V.z} mm (X x Y x Z). The part must fit inside it with margin.`,
  "",
  "Code rules:",
  "- Units are millimetres. Every key dimension is a named variable at the top of the file with a short comment (the user may edit them).",
  "- One print plate: the main part plus any companion parts (see below), side by side with at least 5 mm between them, all inside one top-level union(). Watertight; no zero-thickness walls, no faces that only touch along an edge or at a point.",
  "- Print orientation: the part rests flat on Z = 0, nothing below Z = 0, X/Y centred on the origin. Choose the orientation that needs no supports.",
  "- No overhangs beyond 45 degrees and no bridges longer than 10 mm; use chamfers (not fillets) on bottom edges, teardrop or diamond shapes for horizontal holes over 6 mm.",
  "- Minimum wall 1.2 mm (3 perimeters); 1.6-2.4 mm for walls that carry load or must flex repeatedly. Minimum feature 0.8 mm. Embossed/debossed detail 0.4-1.0 mm deep, never cutting a wall below 1.2 mm.",
  "- Fits: 0.2 mm clearance per side for snug/press fits, 0.3-0.4 mm for sliding or easy fits, 0.5 mm for parts that must drop in. Holes print ~0.2 mm small: add that to screw holes (M3 clearance 3.4 mm).",
  "- Gears: involute profile built with polygon(); add backlash; bore with a D-flat or hex where it must transmit torque.",
  `- Curves: $fn between 24 and ${MAX_FN_HINT}. Prefer hull() of cylinders/spheres for rounded boxes; avoid minkowski() except on very simple shapes (it is slow on a Raspberry Pi). Loops under 500 iterations.`,
  "- OpenSCAD 2021.01 only: built-in modules and functions, no libraries. Never use import(), include, use, surface(), dxf functions or file= parameters. text() is allowed with the default font only.",
  "",
  "Think like the person who asked:",
  "- Before designing, work out what they will need for the thing to actually be used, and include it without being asked: a bottle or jar gets a screw cap, a box gets a lid, a container that holds liquid gets watertight walls and a thick base, a case gets a way to close it, a wall item gets screw holes, a stand gets a stable footprint and a cable slot if it holds something that charges.",
  "- Companion parts print on the same plate, fit each other with a clearance variable (threads: 0.4-0.6 mm radial clearance, coarse 3-4 mm pitch, built from linear_extrude(twist=...) or stacked polygons — no libraries), and each lies in its no-support orientation (a cap lies open side up).",
  "- Don't add parts the person clearly doesn't want (they said 'just the bottle', or it's a decoration). Name every added part in `notes` (e.g. 'Added a screw cap so the bottle can be closed').",
  "",
  "Honesty rules:",
  "- Real objects the part must fit (phones, bearings, screws, batteries, existing parts) need real dimensions. Use the dimensions given in the request. When a dimension is not given, use your best knowledge and list it in `assumptions` with the number and where it comes from (e.g. 'phone body assumed 150.0 x 72.0 x 8.0 mm from the maker's published specs as I remember them; not verified').",
  "- Never claim an exact fit for a measurement you assumed. Camera bump, button and port positions of devices are always assumptions unless given.",
  "- `notes`: 1-4 short tips for printing or assembling (e.g. infill, which side faces up, how the part snaps in).",
].join("\n");

export function buildCadPrompt(input: CadPromptInput, history: FailedAttempt[] = []): string {
  const lines: string[] = [`Design this part: ${input.description.trim()}`];
  const dims = Object.entries(input.dimensions ?? {}).filter(([, v]) => Number.isFinite(v));
  if (dims.length) {
    lines.push("", "Dimensions given by the user (mm, use them exactly):");
    for (const [k, v] of dims) lines.push(`- ${k}: ${v}`);
  }
  if (input.device) {
    lines.push(
      "",
      `Reference device: ${describeDevice(input.device)}.`,
      "Use these body dimensions. Positions and sizes of the camera island, buttons, ports and speaker holes are NOT in the reference: state the ones you use in `assumptions`.",
    );
  } else if (mentionsDevice(input.description)) {
    lines.push(
      "",
      "The device named here is NOT in Morphix's reference table of measured devices. Use your best knowledge of its dimensions and list every one you rely on in `assumptions` (body height, width, thickness, corner radius, camera island, buttons, ports), saying how confident you are.",
    );
  }
  if (isFitCritical(input.description)) {
    lines.push(
      "",
      "This part has to fit something. Put the fit clearance in its own variable. For a phone case: open-top shell printed back-down, inner cavity = body + 0.3 mm per side, walls 1.6-2.0 mm, a lip of about 1 mm over the screen edge, generous cut-outs for camera (+1.5 mm margin), buttons and ports, and keep any decorative pattern on the outside of the back.",
    );
  }
  if (input.baseScad?.trim()) {
    lines.push(
      "",
      "This is a CHANGE to the user's existing design. Start from this OpenSCAD (it already printed-checked fine), make only the change asked for, and keep its sizes, style and variables otherwise. If the change adds a separate part (a lid, a cap, a stand), lay it out next to the original on the bed so both print together, and make anything that fits together (threads, lids) use a clearance variable.",
      "```openscad",
      input.baseScad.slice(0, 12000),
      "```",
    );
  }
  if (input.photoAnalysis !== undefined && input.photoAnalysis !== null) {
    let json = "";
    try {
      json = typeof input.photoAnalysis === "string" ? input.photoAnalysis : JSON.stringify(input.photoAnalysis);
    } catch {
      json = String(input.photoAnalysis);
    }
    lines.push("", "Photo analysis from the user's photos (may contain estimates; treat measurements here as assumptions unless marked as measured):", json.slice(0, 6000));
  }
  if (history.length) {
    lines.push("", "Your previous attempts failed the automatic checks. Fix the problem and return the complete corrected file.");
    for (const h of history.slice(-2)) {
      lines.push("", `Attempt ${h.attempt} problem: ${h.problem}`, "```openscad", h.scad.slice(0, 12000), "```");
    }
  }
  lines.push("", "Answer with the JSON object only: scad, sizeMm (expected bounding box), assumptions, notes.");
  return lines.join("\n");
}
