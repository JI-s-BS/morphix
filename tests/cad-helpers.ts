// Fakes for the Claude CAD tests: no network, no real openscad.
import { readFile, writeFile } from "node:fs/promises";
import { writeBinaryStl, type ExecFileFn, type ExecResult } from "@morphix/slicing";
import type { CadAnswer } from "@morphix/cad";
import { box } from "./phase3-fixtures";

/** Centred box STL resting on Z = 0. */
export function boxStl(x: number, y: number, z: number, z0 = 0): Buffer {
  return writeBinaryStl(box(x, y, z, { x: -x / 2, y: -y / 2, z: z0 }));
}

/** A box with its top face missing: open edges, not watertight. */
export function openBoxStl(x: number, y: number, z: number): Buffer {
  const m = box(x, y, z);
  const idx = Array.from(m.indices);
  idx.splice(6, 6); // drop the two +Z triangles
  return writeBinaryStl({ positions: m.positions, indices: Uint32Array.from(idx) });
}

export function answer(over: Partial<CadAnswer> & { scad?: string } = {}): CadAnswer {
  return {
    scad: over.scad ?? "w = 80; d = 60; h = 20;\ntranslate([-w/2, -d/2, 0]) cube([w, d, h]);",
    sizeMm: over.sizeMm ?? { x: 80, y: 60, z: 20 },
    assumptions: over.assumptions ?? [],
    notes: over.notes ?? ["Print at 20% infill."],
  };
}

export interface ClaudeCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status?: number; body: string; contentType?: string; headers?: Record<string, string> };

export function messageBody(a: unknown, stopReason = "end_turn", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: typeof a === "string" ? a : JSON.stringify(a) },
    ],
    stop_reason: stopReason,
    stop_details: null,
    ...extra,
  });
}

/** Claude fetch double answering from a queue (the last reply repeats). */
export function fakeClaude(replies: (Reply | CadAnswer)[]) {
  const calls: ClaudeCall[] = [];
  const queue = [...replies];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    const r: Reply = "scad" in next ? { body: messageBody(next) } : next;
    return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "application/json", ...(r.headers ?? {}) } });
  };
  return { fetch, calls, prompt: (i: number) => String(calls[i]?.body?.messages?.[0]?.content ?? "") };
}

/** openscad double: `behave` decides per run from the SCAD source. */
export function fakeOpenscad(behave: (code: string, run: number) => { stl?: Buffer; code?: number | null; stderr?: string; timedOut?: boolean }) {
  const runs: string[] = [];
  const exec: ExecFileFn = async (_file, args): Promise<ExecResult> => {
    if (args[0] === "--version") return { code: 0, stdout: "", stderr: "OpenSCAD version 2021.01", timedOut: false };
    const out = args[args.indexOf("-o") + 1];
    const code = await readFile(args[args.length - 1], "utf8");
    runs.push(code);
    const b = behave(code, runs.length);
    if (b.stl) await writeFile(out, b.stl);
    return { code: b.code === undefined ? 0 : b.code, stdout: "", stderr: b.stderr ?? "", timedOut: !!b.timedOut };
  };
  return { exec, runs };
}

export const missingOpenscad: ExecFileFn = async () => ({ code: null, stdout: "", stderr: "\nENOENT: spawn openscad ENOENT", timedOut: false });
export const noSleep = async () => undefined;
