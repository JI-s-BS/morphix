# Phase 3 — Print preparation engine

`packages/slicing` turns a Meshy GLB or any STL into a repaired, scaled, oriented,
plate-centred STL, slices it with an **existing** slicer (PrusaSlicer, or OrcaSlicer as a
fallback), and wraps the G-code in a FlashForge-style `.gx` container.

It is a pure TypeScript library for the Electron **main** process (it uses `node:fs` and
`node:child_process`). It never opens a socket and never talks to the printer. The only
process it can start is a locally installed slicer, through `execFile` with no shell.
It adds no new npm dependencies.

> **Nothing it produces may be sent to the QD330 yet.** The slicer profiles and the
> `.gx` layout are unverified guesses until they have been compared with a file exported
> by the official Afinia slicer (see [Validating against a real .gx](#validating-against-a-real-afinia-gx)).

## Quick start (Electron main)

```ts
import { preparePrint } from "@morphix/slicing";

const r = await preparePrint({
  inputPath: "/home/pi/Morphix/models/abc/model.glb", // or { buffer, format: "glb" | "stl" }
  targetHeightMm: 50,                                 // strongly recommended for Meshy output
  options: {
    supports: "auto",            // "none" (default) | "auto" | "buildplate"
    orientation: "auto",         // default; "keep" = use the model as given
    outputDir: "/home/pi/Morphix/jobs/abc",           // default: a temp dir
    onProgress: (stage) => send("prepare:stage", stage),
  },
});

r.fits.message;        // "Fits: 30.0 x 20.0 x 50.0 mm ..." or "Too large: ... Scale to at most 73% ..."
r.report.input.issues; // ["36 open (boundary) edges: mesh is not watertight", ...]
r.repair;              // what repair changed
r.estimates;           // { printTimeS, filamentMm, filamentG, layerCount, source: "slicer" | "mesh-heuristic" }
r.slicer;              // { ok: true, ... } or { ok: false, reason: "slicer-not-installed" | "too-large" | ... , message }
r.gx;                  // { ok: true, buffer, validation, verified: false } or { ok: false, reason, message }
r.files;               // { dir, stl, thumbnail, gcode?, gx? }
```

`preparePrint` throws only for unreadable input (`MeshFormatError`: not an STL/GLB, a
Draco-compressed GLB, an empty mesh). Every later problem comes back as a structured
result with a `reason`.

### Pipeline

1. **Load and normalise up axis** (`result.upAxis`). The input is STL (binary or ASCII) or GLB.
   A GLB is converted from glTF Y-up to printer Z-up, `(x, y, z) → (x, −z, y)`, and multiplied
   by `glbUnitScaleMm` (default 1000 = metres). Meshy units are *not* reliable, so pass
   `targetHeightMm`; the Phase 2 default display height is 80 mm.
   Meshy now also stores `model.stl`, and **its up axis is unverified**. With `upAxis: "auto"`
   (the default), an STL is checked with `detectUpAxis`:
   - If `options.referenceGlb` is given, or a same-named `.glb` sits next to the STL (Meshy's
     `model.glb`), the STL's bounding-box proportions are matched against the GLB's. This is
     scale-independent, and `method` is `"reference"`.
   - Otherwise it compares the flat-base area at the bottom of Z with the bottom of Y, and
     reports Y-up only on strong evidence (`"heuristic"`).
   - If neither gives evidence, it assumes Z-up (`"default"`) and adds a warning.
   Pass `upAxis: "z"` or `"y"` to force the interpretation for either format.
2. **Validate** (`report.input`).
3. **Repair** (`repair`). Can be turned off with `repair: false`, or tuned by passing a `RepairOptions` object.
4. **Scale**: the Z extent becomes `targetHeightMm`. This happens *before* orientation, so the
   height is the model's natural upright height.
5. **Orient**: `autoOrient` (see below), unless `orientation: "keep"`.
6. **Place**: centred on the plate (110, 110) with min Z = 0.
7. **Fit check** against 220 × 220 × 220 mm. If the model is too large, slicing is skipped with `reason: "too-large"`.
8. **Slice** with PrusaSlicer/OrcaSlicer. If none is installed, the result is `reason: "slicer-not-installed"`
   and `estimates` fall back to a rough mesh heuristic.
9. **.gx**: header filled from the G-code, an 80×60 grey thumbnail, then the G-code. The file is
   validated with `validateGx`.

`result.ok` is true only when a `.gx` was produced and passed validation. Even then the
result carries `gx.verified === false` and a warning that the format is unverified.

## API surface

All exports come from `@morphix/slicing` (`packages/slicing/src/index.ts`). The Phase 1/2
helpers `checkBuildVolume`, `stlSize` and `scaledCheck` are unchanged.

| Module | Main exports |
|---|---|
| `mesh.ts` | `Mesh` (`positions: Float32Array`, `indices: Uint32Array`), `computeBounds`, `signedVolume`, `surfaceArea`, `scaleMesh`, `translateMesh`, `rotateMesh`, `rotationBetween`, `mergeMeshes`, `computeFaceNormals` |
| `stl.ts` | `parseStl(buf)`, `writeBinaryStl(mesh)`, `writeAsciiStl(mesh)`, `isBinaryStl`, `MeshFormatError` |
| `glb.ts` | `parseGlb(buf, { unitScaleMm, zUp })` → `{ mesh, meshCount, primitiveCount, skippedPrimitives }`, `isGlb`, `buildGlb` (test/debug writer) |
| `topology.ts` | `weldVertices`, `edgeStats`, `findShells`, `degenerateTriangles` |
| `validate.ts` | `validateMesh(mesh)` → `ValidationReport` |
| `repair.ts` | `repairMesh(mesh, opts)` → `{ mesh, summary: RepairSummary }` |
| `upaxis.ts` | `detectUpAxis(mesh, reference?)`, `yUpToZUp`, `normalizeUpAxis` |
| `place.ts` | `scaleToHeight`, `placeOnPlate`, `checkFit`, `autoOrient`, `applyOrientation`, `DEFAULT_BUILD_VOLUME` |
| `gcode.ts` | `analyzeGcode(text)` → `GcodeEstimates`, `extractLayers(text, opts)` → `Layer[]`, `parseDuration` |
| `thumbnail.ts` | `renderThumbnail`, `gxThumbnailBmp`, `encodeBmp24`, `decodeBmp24` |
| `gx.ts` | `writeGx`, `readGx`, `validateGx`, `compareGxHeaders`, `isGx`, `GX_LAYOUT_VERIFIED` (= false) |
| `profiles.ts` | `QD330_PLA_DEFAULTS`, `resolveProfilePaths`, `parsePrusaIni` |
| `slicer.ts` | `detectSlicers`, `sliceStl`, `prusaArgs`, `parseSlicerVersion`, `ExecFileFn` |
| `prepare.ts` | `preparePrint`, `loadMesh` (returns Z-up mesh + `upAxis`), `gxFromGcode`, `heuristicEstimates` |

### Validation report (`validateMesh`)

The report includes triangle and vertex counts, unique vertices after welding, bounds,
surface area, |volume|, `inverted` (negative signed volume), degenerate faces, and edge
statistics: boundary/open, non-manifold (more than 2 faces) and inconsistently wound
edges. It also has the flags `watertight`, `manifold` and `consistentWinding`, the shell
count, per-shell info (largest 20), any non-finite coordinates, a human-readable
`issues[]`, and `printable`. Analysis runs on a welded copy (tolerance 1e-6 × bbox
diagonal), so raw STL soup is handled.

### Repair (`repairMesh`)

Repair does the following, in order: weld duplicate vertices; drop degenerate faces
(collapsed or ~zero area) and duplicate faces; remove disconnected shells smaller than
`minShellAreaFraction` (default 0.1 % of the surface; the largest shell is always kept);
make winding consistent per shell (BFS across manifold edges); and flip any shell with
negative volume so its normals face outward. Normals are always recomputed when writing
STL. Every change is counted in `RepairSummary`.

It **does not fill holes** or fix self-intersections. Open edges stay open, and the
result says so. PrusaSlicer runs its own repair when it imports a model.

### Auto-orientation (`autoOrient`)

The candidate "down" directions are the 6 axis directions plus up to 12 of the largest
area-weighted clusters of similar face normals. Each candidate gets a score, and lower is better:

```
score = (overhangArea − 2 · baseArea) / totalArea + 0.1 · height / diagonal
```

`baseArea` is the area of faces within 5° of straight down that touch the bed.
`overhangArea` is the other faces that point more than 45° downward. The current
orientation is kept unless another candidate beats it by `keepBias` (0.05), so organic
Meshy figurines with a base usually stay upright. Boxy models may be laid on their
largest face: a 30×30×60 box is laid down. Use `orientation: "keep"` to disable this.
`result.orientation.candidates` lists every scored candidate for debugging and UI.

### Slicer integration

- **Detection** (`detectSlicers`) checks `$MORPHIX_PRUSA_SLICER` and `$MORPHIX_ORCA_SLICER`
  first, then looks for `prusa-slicer`, `PrusaSlicer`, `prusa-slicer-console`, `orca-slicer`
  and `OrcaSlicer` on `$PATH`, `/usr/bin`, `/usr/local/bin`, `/opt/...` and `/snap/bin`.
  PrusaSlicer is preferred. Detection reads the version from `--help`.
- **Pi install**: `sudo apt install prusa-slicer` (Debian 13 arm64 ships 2.9.x).
  *Unverified:* whether the Debian build's CLI runs headless with no `DISPLAY`. If it
  does not, run it under `xvfb-run` by pointing `MORPHIX_PRUSA_SLICER` at a wrapper script.
- **PrusaSlicer command** (from `prusaArgs`):
  `prusa-slicer --export-gcode --load config/slicer-profiles/qd330-pla-0.2mm.ini --output <dir>/slice/morphix.gcode --center 110,110 [--support-material --support-material-auto [--support-material-buildplate-only]] [--layer-height h --first-layer-height h] [--fill-density N%] <model.stl>`
- **OrcaSlicer command (experimental)**:
  `orca-slicer --slice 0 --load-settings "machine.json;<per-job process.json>" --load-filaments pla.json --outputdir <dir> <model.stl>`.
  The output is whichever `*.gcode` appears in the output dir (Orca names it `plate_1.gcode`).
  Orca's standalone JSON profiles have never been run against a real Orca build.
- **Failures** come back as `{ ok: false, reason }`, where `reason` is one of
  `"slicer-not-installed"`, `"profile-missing"`, `"slicer-failed"` (with the log tail),
  `"timeout"` (default 15 min) or `"no-output"`.
- **Profiles** are found in the `profilesDir` option, then `$MORPHIX_SLICER_PROFILES`, then
  `config/slicer-profiles` in the cwd or up to 4 parent directories. In the packaged
  kiosk, pass `profilesDir` explicitly (e.g. `path.join(app.getAppPath(), "config/slicer-profiles")`).
- **G-code analysis** (`analyzeGcode`) reads the comments written by PrusaSlicer, OrcaSlicer
  and Cura (print time, filament mm/g/cm³, layer count/height, generator) and the first
  M104/M109 and M140/M190 temperatures. When comments are missing, it simulates the
  moves (absolute/relative E, G92, G20/21) to compute filament use, layers and a
  feedrate-only time (×1.15; it ignores acceleration).
- **Layer preview** (`extractLayers(gcode, { includeTravel, maxLayers })`) returns
  `{ index, z, heightMm, extrudedMm, paths: [{ kind: "extrude" | "travel", feature, points: [x0, y0, x1, y1, ...] }] }`.
  A new layer starts at the first extrusion at a new Z, so it does not depend on
  slicer-specific layer comments. `feature` comes from `;TYPE:` (Prusa) or `; FEATURE:` (Orca).
  Arcs are drawn as chords.

### The `.gx` container

The layout comes from community reverse engineering of FlashForge FlashPrint output. Two
independent sources agree on every offset: the GPLv3 Cura plugin
`ronoaldo/FlashforgeFinderIntegration` (`plugins/GXWriter/gx.py`) and the Rust crate
[`xgcode`](https://docs.rs/crate/xgcode/latest). Our code was written from the documented
layout. No code was copied.

| Offset | Type | Field | We write |
|---|---|---|---|
| 0x00 | 12 B | magic `"xgcode 1.0\n\0"` | — |
| 0x0C | u32 | unknown | 0 |
| 0x10 | u32 | thumbnail offset | 58 |
| 0x14 | u32 | G-code offset | 14512 |
| 0x18 | u32 | G-code offset (repeat) | 14512 |
| 0x1C | u32 | print time (s) | from slicer |
| 0x20 | u32 | filament, right/only extruder (mm) | from slicer |
| 0x24 | u32 | filament, left extruder (mm) | 0 |
| 0x28 | u16 | multi-extruder type | **11** (community value, meaning unknown) |
| 0x2A | u16 | layer height (µm) | 200 |
| 0x2C | u16 | reserved | 0 |
| 0x2E | u16 | perimeter shells | 2 |
| 0x30 | u16 | print speed (mm/s) | 60 |
| 0x32 | u16 | bed temp (°C) | from G-code (60) |
| 0x34 | u16 | extruder temp, right (°C) | from G-code (210) |
| 0x36 | u16 | extruder temp, left (°C) | 0 |
| 0x38 | u16 | reserved | **1** (community value) |
| 0x3A | 14454 B | 80×60 24-bit BMP, bottom-up | grey isometric render |
| 0x38B0 | … | G-code text to EOF | slicer output, unchanged |

`readGx` follows the offsets stored in the header rather than the constants, so it can
read files that differ from this layout. `validateGx` checks the magic, offsets, BMP size
and format, that the G-code is present and contains moves, and that header values are
plausible. `compareGxHeaders(ours, reference)` splits header differences into
**structural** fields (offsets, unknown/reserved fields, multi-extruder type), which must
match, and **job** fields (time, filament, temperatures), which differ per print.

## Verified vs unverified

| Item | Status |
|---|---|
| STL read/write, GLB geometry read, Y-up → Z-up | Verified by unit tests (synthetic files) |
| Up axis of Meshy's `model.stl` | **UNVERIFIED** — detected automatically (sibling GLB proportions, then a flat-base heuristic). Check `result.upAxis` on the first real Meshy job |
| Validation, repair, scaling, placement, fit check, orientation heuristic | Verified by unit tests (synthetic meshes); **not yet run on real Meshy output** |
| `.gx` writer/reader round-trip and the community byte layout | Verified by unit tests against the documented layout |
| `.gx` layout matching **Afinia** QD330 output | **UNVERIFIED** — no official Afinia `.gx` has been compared yet |
| Values at 0x28 (11) and 0x38 (1), thumbnail style | **UNVERIFIED** (copied from community writers) |
| Whether the printer requires the header values to match the G-code | **UNVERIFIED** |
| Slicer profiles (`config/slicer-profiles/*`), incl. start/end G-code and `gcode_flavor = marlin` | **UNVERIFIED guesses** — the start/end G-code is generic Marlin-style and most likely wrong for this FlashForge-family firmware |
| Build volume 220×220×220 | From the M115 firmware report; **not confirmed** against the official spec |
| PrusaSlicer CLI flags/behaviour | Matches PrusaSlicer 2.x CLI docs; **never run in this repo** (tests use a fake runner) |
| OrcaSlicer CLI + standalone JSON profiles | **Experimental**, never run |
| Headless PrusaSlicer on the Pi (no X display) | **UNVERIFIED** |
| G-code estimate parsing | Verified against hand-written fixtures in the PrusaSlicer/Orca comment formats, not against real output |
| Performance | ~3 s for a 300k-triangle STL through `preparePrint` (no slicing) on a desktop x86. Expect several times slower on a Pi 4 |

## Validating against a real Afinia .gx

The printer already stores official files such as `cute-bear-keychain-with-hole.gx`.
**Do not send anything to the printer for this.** These steps only *read* a file.

1. **Get an official file.** Either export one from the official Afinia slicer on a PC
   (preferred: also note every setting used, such as layer height, temperatures, shells
   and speed), or have the printer integrator copy one off the printer with the
   read-only tools that already exist. Put it outside the repo, e.g. `~/Morphix/reference/bear.gx`.
2. **Dump its header** (from the repo root):
   ```bash
   node -e '
     const { readFileSync } = require("node:fs");
     const b = readFileSync(process.argv[1]);
     console.log(JSON.stringify({ magic: b.subarray(0, 16).toString("hex"), size: b.length }, null, 1));
     const f = ["u32 0x0C","u32 0x10","u32 0x14","u32 0x18","u32 0x1C","u32 0x20","u32 0x24","u16 0x28","u16 0x2A","u16 0x2C","u16 0x2E","u16 0x30","u16 0x32","u16 0x34","u16 0x36","u16 0x38"];
     for (const s of f) { const [t, o] = s.split(" "); const off = parseInt(o, 16); console.log(o, t === "u32" ? b.readUInt32LE(off) : b.readUInt16LE(off)); }
     console.log(b.subarray(b.readUInt32LE(0x14), b.readUInt32LE(0x14) + 1500).toString("latin1"));
   ' ~/Morphix/reference/bear.gx
   ```
   or, in a vitest scratch test or the Electron main process:
   ```ts
   import { readGx, validateGx, compareGxHeaders } from "@morphix/slicing";
   const ref = readFileSync("/home/pi/Morphix/reference/bear.gx");
   console.log(validateGx(ref));                  // errors/warnings against the community layout
   console.log(readGx(ref).header);
   ```
3. **Check the structure.** Expect magic `78 67 63 6f 64 65 20 31 2e 30 0a 00` and offsets
   58 / 14512 / 14512. Note the actual values at 0x0C, 0x28, 0x2C and 0x38. If
   `validateGx(ref)` reports **errors**, the community layout is wrong for the QD330: stop
   and investigate before going further.
4. **Compare with ours.** Slice the same model at the same settings with `preparePrint`,
   then run `compareGxHeaders(ourGx, ref)`. Every `kind: "structural"` difference must be
   resolved, for example by setting `multiExtruderType` / `reserved38` in `writeGx`. Job
   differences show how close the PrusaSlicer estimates are to Afinia's.
5. **Compare the G-code preamble.** Print `compareGxHeaders(...).referenceGcodeHead` (the
   first 2000 bytes of the official G-code). Copy its start sequence (heating, homing,
   any FlashForge-specific M-codes such as `M118`, `M601`, `M651`, `M132`…), its end
   sequence (from the tail of the file) and its comment header lines into
   `start_gcode` / `end_gcode` in `config/slicer-profiles/qd330-pla-0.2mm.ini` (and the
   Orca machine JSON). Also check the extrusion mode (`M82`/`M83`) and whether it uses
   G0 or only G1. These are the most likely reasons the earlier plain `.g` job stalled at 0 %.
6. **Thumbnail.** Decode the reference BMP (`decodeBmp24(readGx(ref).thumbnailBmp)`) and
   check its size, bit depth, and whether it is grey or colour.
7. **Only then** consider a supervised test print of a tiny calibration cube. That goes
   through the existing approval gates (domain workflow) and the printer package, not
   this library. When it works, set `GX_LAYOUT_VERIFIED` / `QD330_PLA_DEFAULTS.verified`
   and update the table above.

## Integration notes

- Call `preparePrint` from the **main** process, not the renderer. It is CPU-bound (repair
  and orientation are synchronous) and can block the main thread for seconds on large
  meshes. For a smooth kiosk UI, run it in a `worker_threads` Worker or utility process.
- The returned `Buffer`s (`repairedStl`, `thumbnailBmp`, `gx.buffer`) are large. Send
  file paths (`result.files`) or summaries over IPC, not the buffers.
- `extractLayers` on a big print returns a lot of data. Use `maxLayers`, or extract one
  layer range at a time, and keep `includeTravel` off unless it is needed.
- Uploading the `.gx` to the printer is out of scope. It must go through the approval
  gates (`packages/domain`) and only after the validation above.

## AI slicer advisor

`packages/slicing/src/advisor.ts` and `advised.ts`, exported from `@morphix/slicing`. The advisor
picks slicer settings for a prepared model. A deterministic heuristic engine always answers.
Gemini can optionally refine that answer, but the refinement is validated, clamped to safe ranges
and falls back to the heuristic on any error.

### `prepareWithAdvice(input)`

This is a drop-in alternative to `preparePrint`. It takes the same input plus
`intendedUse?: "functional" | "decorative" | "unknown"`, `description?`,
`gemini?: AdvisorGeminiOptions | false`, `availableSlicers?` and
`onProgress?(stage | "advise")`. It returns the normal `PreparePrintResult` plus three fields:

- `advice`: a `SlicingAdvice` (see below).
- `overhang`: an `OverhangStats` measurement of the prepared mesh.
- `applied`: the settings actually passed to the slicer, with `overriddenByCaller` listing the
  ones taken from `options`.

```ts
const r = await prepareWithAdvice({
  inputPath: ".../model.stl",
  targetHeightMm: 80,
  description: "a phone stand",            // from the voice request
  gemini: advisorGeminiFromEnv(),          // false when GEMINI_API_KEY is unset
  options: { outputDir },
});
r.advice.reasons;   // kid-friendly lines for the report / voice
r.applied;          // { slicer, supports, layerHeightMm, infillPercent, perimeters, brimWidthMm, orientation }
```

How it runs:

1. It runs the mesh stages (load, repair, scale, orient, place) with slicing off.
2. It measures overhangs on the prepared STL, detects slicers (unless `options.slicer` or
   `availableSlicers` is given) and calls `adviseSlicing`.
3. If the advice is `orientation: "keep"`, auto-orient had rotated the model, and the caller left
   `options.orientation` unset, it re-runs the mesh stages with `"keep"` and asks for advice again.
4. It slices the prepared STL (repair off, orientation `keep`, up axis `z`) with the advised
   settings into the same output directory. The result keeps the first pass's input report,
   repair summary, scale, orientation and up axis.

Anything set explicitly in `options` wins over the advice: `supports`, `layerHeightMm`,
`infillPercent`, `perimeters`, `brimWidthMm`, `orientation` and `slicer`. A model that is too big
stops before slicing, with `slicer.reason = "too-large"`. When no slicer is installed you get the
usual `slicer-not-installed` result, plus an advice warning that explains how to install one.

### `adviseSlicing(input, { gemini })` and `heuristicAdvice(input)`

Input: `{ size, validation?, mesh?, overhang?, orientation?, intendedUse?, description?,
availableSlicers?, buildVolume?, lockOrientation? }`.

Output (`SlicingAdvice`): `{ slicer, slicerPath, layerHeightMm, infillPercent, walls, supports,
orientation, brim, brimWidthMm, intendedUse, reasons[], warnings[], confidence, source:
"heuristic" | "gemini", model?, fallback? }`.

Heuristic rules (all values are clamped to `ADVICE_LIMITS`: layer 0.10–0.30 mm, infill 5–80 %,
walls 2–5, brim 0–10 mm):

| Situation | Advice |
| --- | --- |
| No overhang area, or less than 5 % at more than 45°, less than 0.5 % at more than 60°, and max angle under 65° | `supports: "none"` |
| Overhangs, with at least 90 % of their area above only the plate | `supports: "buildplate"` |
| Overhangs above other parts of the model | `supports: "auto"` |
| No overhang data, only the orientation candidate | `auto` if more than 2 % of the surface overhangs (lower confidence) |
| Height / smallest footprint side > 2.5 and height > 30 mm | brim 5 mm (8 mm when the ratio is > 4) |
| Bed contact < 15 % of the footprint and < 150 mm² (height > 15 mm) | brim 5 mm |
| Footprint side > 150 mm | brim 4 mm (corner curl) |
| Functional | infill 30 %, 3 walls; "strong", "bracket", "hook", "gear"… → 40 %, 4 walls |
| Decorative | infill 10 % |
| Largest side < 25 mm | 0.12 mm layers |
| Decorative and largest side < 60 mm | 0.15 mm layers |
| Height > 150 mm or volume > 250 cm³ | 0.28 mm draft (0.25 mm if functional) |
| Decorative, auto-orient rotated it, and the original pose has < 10 % overhang | `orientation: "keep"` |
| Slicer | PrusaSlicer if installed, otherwise OrcaSlicer, otherwise `null` plus an install hint |

`intendedUse: "unknown"` is inferred from keywords in the description (`inferIntendedUse`).

`overhangStats(mesh)` measures the oriented mesh: total area, bed contact, overhang area above
45° and above 60°, the steepest overhang angle covering at least 0.1 % of the surface, and
`plateReachableRatio`. That ratio comes from a 64×64 XY grid. For each overhang sample it looks
at the highest upward-facing surface below. If there is none, the overhang is above the plate.
If that surface is within 0.5 mm, the face is resting on the model. Otherwise, supports would
stand on the model. Faces of separate shells that rest on each other count as overhang area,
but also as reachable.

### Gemini refinement

Gemini refinement uses REST `models/{model}:generateContent` with
`generationConfig.responseMimeType = "application/json"` and `responseJsonSchema =
ADVISOR_RESPONSE_SCHEMA`. The API key goes only in the `x-goog-api-key` header. The model
defaults to `gemini-3.8-flash` (`DEFAULT_GEMINI_TEXT_MODEL`); override it with
`MORPHIX_GEMINI_TEXT_MODEL`. `advisorGeminiFromEnv(env)` reads `GEMINI_API_KEY` and
`MORPHIX_GEMINI_TEXT_MODEL`. `fetch` is injectable and the timeout defaults to 20 s.

The prompt sends only measured facts (size, volume, watertightness, overhang numbers, the
description) and the heuristic suggestion, never the mesh. The answer goes through these
safeguards:

- Every field is type-checked; an invalid answer means fallback.
- Numbers are clamped to `ADVICE_LIMITS`, and confidence is capped at 0.95.
- The slicer is always the heuristic's choice, because Gemini cannot install software.
- Gemini may add supports, but it cannot remove them when the overhang is real (≥ 1 % severe
  or ≥ 8 % overhang).
- `buildplate` is upgraded to `auto` when the overhangs sit above the model.
- The brim on tall, thin parts is kept.

On any failure (network, HTTP error, timeout, blocked prompt, bad JSON) you get the heuristic
advice with `fallback` set to a serialised `MX-SLICE-012`, plus a closing reason saying the
built-in rules were used.

### Slicer wrapper additions (backwards compatible)

`SliceOptions` and `PreparePrintOptions` gain two optional fields, `brimWidthMm` and
`perimeters`. When omitted, nothing changes and the profile values are used.

- PrusaSlicer: they become `--brim-width <mm>` and `--perimeters <n>`.
- OrcaSlicer: they set `brim_type` (`outer_only` / `no_brim`), `brim_width` and `wall_loops`
  in the generated process JSON.
- `gxFromGcode` takes an optional `shells` argument, so the `.gx` header reports the perimeters
  actually used.

### Integration (coordinator)

- In `apps/desktop/electron/printing.ts`, replace `preparePrint(...)` with
  `prepareWithAdvice({ ...sameInput, description: project.prompt, gemini: advisorGeminiFromEnv() })`.
  Store `advice` and `applied` in the preparation summary and show `advice.reasons` in the
  report.
- Pass `trackPrepare(jobs, jobId).onProgress` as `onProgress`, then call `finish(result)` (see
  [JOBS.md](JOBS.md)).
- Add `MORPHIX_GEMINI_TEXT_MODEL=` (optional) to `config/morphix.env.example`.
