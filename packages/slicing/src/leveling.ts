// Bed leveling before every print.
//
// What is known (Afinia QD330 User Guide, 01-12-2024, §5.1 and Q&A Q3/Q5): the printer has
// "one-click auto leveling" run by its own firmware. The guide says the printer "defaults to
// the leveling operation before each print" and that it can be switched on in the printer's
// settings ("enable automatic leveling before printing"). It does not name a G-code for it,
// and no official Afinia .gx has been compared yet (docs/PHASE3.md), so Morphix has NO
// verified leveling command.
//
// So there are two modes:
//   - "gcode" (default, the command is UNVERIFIED): every print levels the bed. Leveling
//     commands are written into the start G-code, after homing and with the bed at
//     temperature, before the nozzle heats and primes. The command is G29, the conventional
//     bed-leveling G-code; MORPHIX_LEVEL_GCODE replaces it with what an official Afinia .gx
//     actually uses once one has been read (checklist L2, docs/PHASE5.md).
//   - "printer" (MORPHIX_LEVELING=printer): nothing is added; the QD330's own pre-print routine
//     levels the bed ("automatic leveling before printing" on at the printer, checklist L1).

/** Where the slicer profiles' start G-code levels the bed. Replaced by applyLeveling(). */
export const LEVEL_MARKER = ";MORPHIX_LEVEL_BED";

/** UNVERIFIED candidate, written into every print unless MORPHIX_LEVEL_GCODE replaces it. */
export const CANDIDATE_LEVEL_GCODE: readonly string[] = ["G29"];

export type LevelingPlan =
  | { mode: "printer" }
  | { mode: "gcode"; commands: string[]; verified: false };

export interface LevelingReport {
  mode: LevelingPlan["mode"];
  /** Commands written into the file (empty in "printer" mode). */
  commands: string[];
  /** The start G-code had the LEVEL_MARKER (false: commands went after the first G28). */
  markerFound: boolean;
  warnings: string[];
}

// Each leveling command is one bare word plus simple parameters. Anything that moves,
// extrudes, heats, starts/stops jobs, writes files or halts the firmware is refused.
const COMMAND_SHAPE = /^[A-Z][A-Z0-9_]{0,31}(?: [A-Z0-9_]+(?:=[A-Za-z0-9_.-]+|[0-9.-]*))*$/;
const REFUSED = /^(?:G0|G1|G2|G3|G28|G10|G11|G92|M1?0[49]|M1[49]0|M10[67]|M2[0-9]|M3[0-9]|M5[0-9]{2}|M6[0-9]{2}|M112|M84|M18|M500|M502|SAVE_CONFIG|FIRMWARE_RESTART|RESTART|SET_KINEMATIC_POSITION)$/;

/** Checks operator-supplied leveling commands. Throws with the reason for the first bad one. */
export function validateLevelCommands(commands: readonly string[]): string[] {
  if (commands.length === 0 || commands.length > 4) throw new Error("leveling needs 1 to 4 commands");
  return commands.map((raw) => {
    const c = raw.trim().replace(/[ \t]+/g, " ");
    const [verb, ...params] = c.split(" ");
    if (!COMMAND_SHAPE.test(c) || params.some((p) => /^[GM]\d/.test(p))) throw new Error(`leveling command "${raw}" is not a single plain G-code/macro line`);
    if (REFUSED.test(verb)) throw new Error(`leveling command "${verb}" is not allowed (it moves, heats, extrudes, controls jobs or changes the firmware)`);
    return c;
  });
}

/**
 * The plan for this Morphix install: level the bed in every print ("gcode") unless the operator
 * leaves it to the printer's own routine (`printerOnly`, MORPHIX_LEVELING=printer).
 * `commandsText` is MORPHIX_LEVEL_GCODE: commands separated by ";" or new lines.
 */
export function levelingPlan(o: { printerOnly?: boolean; commandsText?: string | null } = {}): LevelingPlan {
  if (o.printerOnly) return { mode: "printer" };
  const text = (o.commandsText ?? "").trim();
  const commands = text ? text.split(/[;\n]/).map((x) => x.trim()).filter(Boolean) : [...CANDIDATE_LEVEL_GCODE];
  return { mode: "gcode", commands: validateLevelCommands(commands), verified: false };
}

/** Writes the plan into sliced G-code at LEVEL_MARKER (or right after the first G28). */
export function applyLeveling(gcode: string, plan: LevelingPlan = levelingPlan()): { gcode: string; report: LevelingReport } {
  const lines = gcode.split("\n");
  const markerAt = lines.findIndex((l) => l.trim() === LEVEL_MARKER);
  const warnings: string[] = [];
  const commands = plan.mode === "gcode" ? validateLevelCommands(plan.commands) : [];
  const block =
    plan.mode === "gcode"
      ? ["; Morphix: level the bed before every print (UNVERIFIED command; MORPHIX_LEVELING=printer turns it off)", ...commands, "G1 Z10 F600 ; clear of the bed before travelling"]
      : ["; Morphix: the QD330 levels the bed itself before this file runs (printer setting: automatic leveling before printing)"];
  if (markerAt >= 0) {
    lines.splice(markerAt, 1, ...block);
    return { gcode: lines.join("\n"), report: { mode: plan.mode, commands, markerFound: true, warnings } };
  }
  if (plan.mode === "printer") return { gcode, report: { mode: plan.mode, commands, markerFound: false, warnings } };
  // A start G-code without the marker: level straight after homing, before the first layer.
  const firstLayer = lines.findIndex((l) => /^;LAYER_CHANGE\b/.test(l));
  const homeAt = lines.findIndex((l, i) => (firstLayer < 0 || i < firstLayer) && /^G28\s*(?:;.*)?$/.test(l.trim()));
  if (homeAt < 0) {
    warnings.push("no full G28 before the first layer: leveling commands were not added");
    return { gcode, report: { mode: plan.mode, commands: [], markerFound: false, warnings } };
  }
  lines.splice(homeAt + 1, 0, ...block);
  warnings.push(`start G-code has no ${LEVEL_MARKER}: leveling was added right after G28, before the bed is at temperature`);
  return { gcode: lines.join("\n"), report: { mode: plan.mode, commands, markerFound: false, warnings } };
}

export interface StartSequence {
  /** Line indexes (-1 = missing), all before the first ;LAYER_CHANGE. */
  home: number;
  bedWait: number;
  level: number;
  nozzleWait: number;
  /** First extruding move (the prime line). */
  prime: number;
  /** True when home < level < nozzleWait < prime and the bed is at temperature before leveling. */
  ordered: boolean;
}

/**
 * Finds the start sequence in G-code (or a raw start_gcode template). `level` is the marker,
 * the Morphix leveling comment, or one of `levelCommands`.
 */
export function startSequence(gcode: string, levelCommands: readonly string[] = CANDIDATE_LEVEL_GCODE): StartSequence {
  const lines = gcode.split("\n").map((l) => l.trim());
  const end = lines.findIndex((l) => /^;LAYER_CHANGE\b/.test(l));
  const head = end < 0 ? lines : lines.slice(0, end);
  const cmd = (l: string) => l.split(";")[0].trim();
  const find = (f: (l: string) => boolean) => head.findIndex(f);
  const home = find((l) => /^G28$/.test(cmd(l)));
  const bedWait = find((l) => /^M190\b/.test(cmd(l)));
  const level = find((l) => l === LEVEL_MARKER || l.startsWith("; Morphix: level the bed") || l.startsWith("; Morphix: the QD330 levels the bed") || levelCommands.includes(cmd(l)));
  const nozzleWait = find((l) => /^M109\b/.test(cmd(l)));
  let e = 0, absE = true;
  const prime = find((l) => {
    const c = cmd(l).toUpperCase();
    if (c === "M83") absE = false;
    if (c === "M82") absE = true;
    const g92 = /^G92\b.*\bE(-?[\d.]+)/.exec(c);
    if (g92) e = Number(g92[1]);
    const m = /^G[01]\b.*\bE(-?[\d.]+)/.exec(c);
    if (!m || !/\b[XY]-?[\d.]/.test(c)) return false;
    const next = absE ? Number(m[1]) : e + Number(m[1]);
    const extrudes = next > e;
    e = next;
    return extrudes;
  });
  const ordered = home >= 0 && level > home && bedWait >= 0 && bedWait < level && nozzleWait > level && prime > nozzleWait;
  return { home, bedWait, level, nozzleWait, prime, ordered };
}
