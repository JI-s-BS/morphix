# Photo to 3D: photos + a description → a printable model

**Status:** library only, tested with mocked Gemini, Meshy and OpenSCAD. **No real API call has been made** (no keys in development), and the OpenSCAD CLI has not been run on the Pi yet. Nothing is wired into the app or the portal.

The user sends one or more photos through the portal, for example a drawing, a snapped phone stand or an object to copy, plus a sentence about what to make. They can also add measurements, say which reference object is in the picture, or upload a 3D scan. Morphix works out what the object is and how big it is, then picks an engine. The result is a binary STL in millimetres, Z-up, centred on the bed, plus a report.

Everything lives in `packages/photo3d/src` and is exported from `@morphix/photo3d`:

| File | What it holds |
|---|---|
| `errors.ts` | `P3D_ERRORS` (the `MX-P3D-nnn` registry), `Photo3dError`, `P3dIssue`, `toIssue` |
| `images.ts` | `checkPhotos` (magic-byte sniffing, limits), `toDataUri`, unit conversion (`toMm`), `overallAxisOf` |
| `gemini.ts` | `GeminiJsonClient`: REST `generateContent` with inline images and a JSON-schema answer |
| `analyze.ts` | `analyzePhotos`, `PhotoAnalysis`, the prompt and schema, `normalizeAnalysis` |
| `meshy-image.ts` | `MeshyImageClient` (Image to 3D + Multi-Image to 3D), `meshyImageCost`, credit constants |
| `openscad.ts` | `checkScadSafety`, `runOpenscad`, `designWithOpenscad` (Gemini → SCAD → STL, up to 3 attempts) |
| `scan.ts` | `parseObj`, `parsePly`, `detectScanFormat`, `importScan` (units and up-axis detection) |
| `dimensions.ts` | `checkDimensions` (±3 %), `chooseScaleAxis`, `scaleToDimension`, `placeOnBed` |
| `pipeline.ts` | `photoToModel`, the orchestrator |
| `env.ts` | `photo3dDepsFromEnv` |

Tests are in `tests/photo3d-*.test.ts`. Every HTTP call goes through an injected `fetch` double and every OpenSCAD run through an injected `exec` double, so no credits are spent and no service is contacted. One test, `real openscad (installed)`, runs only when an `openscad` binary is on PATH.

---

## Quick start

```ts
import { photoToModel, photo3dDepsFromEnv } from "@morphix/photo3d";

const deps = photo3dDepsFromEnv(process.env); // GEMINI_API_KEY, MESHY_API_KEY, …
const result = await photoToModel(
  {
    images: [{ mime: "image/jpeg", bytes: jpegBuffer }],
    description: "Replacement for this snapped phone stand",
    measurements: [{ label: "phone thickness with case", value: 11, unit: "mm" }],
    referenceObject: "credit-card",
  },
  { ...deps, onMeshyTask: (t) => db.saveMeshyTask(jobId, t) },
  (p) => portal.push(jobId, p), // { stage, progress 0-100, detail }
);

switch (result.status) {
  case "needsAnswers": /* show result.questions, then call again with answers */ break;
  case "done":         /* result.files.stl → preparePrint; show result.warnings */ break;
  case "failed":       /* result.error.code is an MX-P3D-nnn code */ break;
}
```

`photoToModel` **never throws**. Every failure comes back as `{ status: "failed", error: { code, message, detail? } }`.

---

## API

### `photoToModel(request, deps, onProgress?) → PhotoToModelResult`

**Request (`PhotoToModelRequest`)**

| Field | Meaning |
|---|---|
| `images` | `{ mime, bytes }[]`, 1 to 8 photos (JPEG, PNG, WebP, HEIC/HEIF). The type is sniffed from the bytes; the declared MIME is only a hint. Max 20 MB each and 14 MB in total, because Gemini's inline limit is about 20 MB after base64. Optional when `scan` is given. |
| `description` | Required. What to make. |
| `measurements` | `{ label, value, unit }[]`. Units are mm, cm, m, in or ft. Labels `width`/`depth`/`length`/`height` (also `overall …`, `x`/`y`/`z`) **override** the overall dimensions. Any other label, such as "hole diameter" or "slot width", goes to Gemini and into the OpenSCAD prompt as a feature measurement. |
| `referenceObject` | `"credit-card" \| "coin" \| "ruler" \| "phone" \| "none"`: a known object placed in the photo for scale. |
| `scan` | `{ name, bytes, units?, upAxis? }`: an OBJ, PLY, STL or GLB scan. When present, the scan engine is used. |
| `engine` | `"auto"` (default) or a forced engine. |
| `answers` | `{ question, answer }[]` replying to an earlier `needsAnswers`. The analysis is re-run with them in the prompt. |
| `skipQuestions` | Build with the best guesses instead of asking. |
| `analysis` | Reuse an earlier `PhotoAnalysis`, so Gemini is not called again for analysis. |
| `dimensionsMm` | `{ width?, depth?, height? }` confirmed by the user, for example after they edit the estimate in the portal. Each axis becomes `user-measurement` with confidence 1 and no questions are asked. |
| `resumeMeshyTask` | `{ kind, id }`: continue polling an existing Meshy task after a restart, with no new task and no new credits. |
| `meshy` | `MeshyImageOptions` (`model`, `texture`, `texturePrompt`, `geometryResolution`, `targetPolycount`, …). |

**Deps (`PhotoToModelDeps`)**: `gemini?: GeminiJsonClient`, `meshy?: MeshyImageClient`, `openscad?: { bin?, exec?, timeoutMs?, tmpRoot?, maxAttempts? }`, `meshyDefaults?`, `maxCredits?` (Meshy engines above this are refused with `MX-P3D-092`), `allowFallback?` (default true), `onMeshyTask?` (persist the task id for resuming), `signal?` (cancel at any point; gives `MX-P3D-090`).

**Progress**: `onProgress({ stage, progress, detail })`. `progress` is the overall percentage and never goes down. Stages in order: `validate` → `analyze` → `questions` (when the run stops to ask) → `design` / `compile` (OpenSCAD) or `generate` / `download` (Meshy) or `import` (scan) → `verify` → `done` or `failed`.

**Result**, one of three shapes:

- `{ status: "needsAnswers", analysis, questions, warnings, costCredits: 0 }`
- `{ status: "done", files: { stl, glb?, scad?, thumbnail? }, engine, dimensions: { intended, actualMm, check }, analysis, report, warnings, costCredits }`
- `{ status: "failed", error, attempts, analysis, warnings, costCredits }`

`files.stl` is the authoritative printable file: binary, mm, Z-up, centred on X/Y, minimum Z = 0, already passed through `repairMesh`. For Meshy, `files.glb` is Meshy's original (textured) GLB in its native scale, for the viewer only. `report` holds the engine attempts (`{ engine, ok, error? }`), the OpenSCAD attempt log (outcome and feedback for each attempt), the Meshy task id with the scale axis and factor, the scan's units and up-axis decisions, the repair summary, a validation summary (`watertight`, `manifold`, `printable`, volume, issues) and `fitsBuildVolume` (220 × 220 × 220 mm).

`costCredits` counts Meshy credits only, using `consumed_credits` or the price table. Gemini calls are not counted. A typical run makes 1 analysis call plus 1–3 OpenSCAD calls.

### Building blocks

- `analyzePhotos({ images, description, measurements?, referenceObject?, hasScanFile?, answers? }, { gemini, signal? }) → PhotoAnalysis`: what the object is, `category` (`functional` / `decorative`), `mechanical`, `recommendedEngine` with `engineReason`, `dimensions.{width,depth,height} = { valueMm, confidence, method, note? }`, `referenceObject.detected`, up to 3 `questions`, `needsAnswers`, `meshyPrompt`, `openscadSpec` (`summary`, `features[]`, `wallThicknessMm`, `holes[] { diameterMm, depthMm | null = through }`, `toleranceMm`, `bedOrientation`, `notes`), `overallConfidence`, `model`.
- `new GeminiJsonClient({ apiKey, model?, baseUrl?, fetch?, timeoutMs? }).generateJson({ parts, schema, system?, temperature?, maxOutputTokens?, signal? })`.
- `new MeshyImageClient({ apiKey, base?, fetch?, pollMs?, timeoutMs? })`: `create(images, opts)`, `get(kind, id)`, `waitFor(kind, id, onUpdate)`, `download(url)`, and `generate(images, { …opts, resume?, onTaskId?, onProgress?, signal? })`, which does all of it.
- `designWithOpenscad({ objectName, description, spec, dimensions, measurements? }, { gemini, bin?, exec?, timeoutMs?, maxAttempts?, tolerance? })`, `runOpenscad(code, opts)`, `checkScadSafety(code)`, `openscadVersion()`.
- `importScan(name, bytes, { units?, upAxis?, expectedSizeMm? })`, `parseObj`, `parsePly`.

---

## Engines

| Engine | Used for | Cost |
|---|---|---|
| `openscad` | Functional parts made of simple geometry: brackets, stands, clips, spacers, hooks, knobs, replacement parts. | Gemini calls only |
| `meshy-image` | Organic or decorative objects and drawings, from one photo. `POST /openapi/v1/image-to-3d`. | 20 credits (meshy-7.1 / meshy-6, mesh only), 30 textured; meshy-6-lite 5 / 15; +5 for `geometryResolution` 2k/4k |
| `meshy-multi-image` | Same, from 2–4 photos of the same object (the first should be the front view). `POST /openapi/v1/multi-image-to-3d`. | Same as above |
| `scan` | A 3D scan file was uploaded. | Free |

**Selection.** Gemini recommends an engine and the pipeline corrects impossible choices. A scan file always means `scan`. `scan` without a file becomes openscad or Meshy. Multi-image with one usable photo becomes single image. `openscad` without a usable spec goes to Meshy. `request.engine` forces an engine.

**Fallback.** `openscad → meshy-(multi-)image`. If OpenSCAD fails for any reason (binary missing, unsafe code, 3 compile failures, timeout, Gemini error), Meshy is tried. Set `allowFallback: false`, or a low `maxCredits`, to prevent spending credits. Meshy and scan failures do not fall back. When every engine fails, the result is `MX-P3D-091`, and each engine's own code is in `attempts`.

### OpenSCAD

1. Gemini receives the spec and the exact bounding box (X width × Y depth × Z height), plus rules: mm units, sitting on Z = 0, one solid, `$fn` 32–96, no overhangs steeper than 45°, standard library only. It answers `{ scad, explanation }`.
2. **Static safety checks** (`checkScadSafety`) run before anything executes. They look at code with comments and strings stripped, and reject:
   - every way of reading other files: `import`, `include <>`, `use <>`, `surface()`, `dxf_*()`, `file=`;
   - `$fn > 256`, `$fs < 0.05`, `$fa < 0.5`;
   - any literal range with more than 2000 steps, or ranges totalling more than 20 000 steps, or a zero step;
   - code with no 3D primitive;
   - code over 64 KB.
   Non-literal loops and recursion can't be bounded statically; the timeout covers those.
3. `openscad -o model.stl model.scad` runs through `execFile`, with no shell, in a fresh `mkdtemp` directory that is deleted afterwards. Timeout is 120 s (`MORPHIX_OPENSCAD_TIMEOUT_S`). ENOENT means `MX-P3D-030` straight away, with no retries and no further Gemini calls.
4. A compile error (the `ERROR:`/parser lines of the log), a timeout, empty geometry or a rejected safety check is fed back to Gemini together with the failing code, for up to **3 attempts**.
5. The STL bounding box is checked against the intended size: each axis must be within **±3 %**, or 0.2 mm for tiny features. A mismatch is also fed back, and the result says so when the axes look swapped. If no attempt matches, the closest compiling model is returned with warning `MX-P3D-050`.

Install on the Pi: `sudo apt install openscad`. Debian 13 ships 2021.01; STL export works headless. Override the binary with `MORPHIX_OPENSCAD_BIN`.

### Meshy Image / Multi-Image to 3D

Images are sent as `data:<mime>;base64,…` URIs. HEIC is not accepted by Meshy and is dropped; Gemini still sees it. The request is `ai_model` (default `meshy-7.1`, set with `MORPHIX_MESHY_IMAGE_MODEL`), `should_texture: false` (prints are single-colour, which saves 10 credits), `should_remesh: true`, `topology: "triangle"`, `target_polycount: 30000`, `target_formats: ["glb","stl"]`. The client polls `GET /openapi/v1/{kind}/{id}` every 3 s, with a 20 min limit. `onTaskId` fires as soon as the id is known, and `resume` continues an existing task. HTTP errors map to 400 → 021, 401 → 022, 402 → 023, 403 → 024, 429 → 025, and anything else → 026. A task that ends `FAILED` or `CANCELED` gives 027; Meshy refunds failed tasks.

Meshy's model has no real-world size, so the pipeline reads the GLB (Y-up by spec, converted to Z-up), repairs it, and scales it **uniformly** so the most trustworthy dimension matches. That is the highest confidence, ties going to the largest dimension. The other two axes are whatever Meshy's proportions give. They are checked with a 10 % tolerance, and only mechanical parts get a warning.

### Scan import

- **Formats:** OBJ (`v`/`f`, `v/vt/vn`, negative indices, polygons fan-triangulated), PLY (ASCII, binary little- and big-endian, any scalar types, extra vertex properties, unknown elements skipped), STL (binary/ASCII), GLB (uncompressed). The format is detected from content first and the file extension second. A file with vertices but no faces (a point cloud) gives `MX-P3D-042`.
- **Units:**
  - `units` given → used as-is.
  - Otherwise, when the photo analysis knows the expected size → the unit among mm, cm, in and m that brings the largest side closest to it (in log terms). It is confident when within 2× and clearly better than the next unit.
  - Otherwise a size rule: largest side ≤ 2.5 file units means metres (phone LiDAR apps such as Polycam, Scaniverse and 3D Scanner App export metres); anything larger means millimetres; GLB counts as metres unless it would be bigger than 3 m.
  - Uncertain guesses are reported in the warning `MX-P3D-043`.
- **Up axis:**
  - `upAxis` given → used.
  - GLB → Y-up (glTF spec).
  - STL → the slicing heuristic, which is Z-up unless a flat base clearly sits at min Y.
  - OBJ/PLY → Y-up (the convention of scanning and DCC apps), unless a flat base at min Z is more than 3× the one at min Y.

---

## How dimensions are estimated, and the limits

Each overall dimension carries a `method` and a `confidence`:

| Method | Where it comes from | Typical confidence |
|---|---|---|
| `user-measurement` | A measurement the user typed, or `dimensionsMm`. Applied deterministically after Gemini, so Gemini cannot override it. | 1 |
| `reference-object` | Gemini scales from a known object in the photo. The prompt gives exact sizes: ID-1 card 85.60 × 53.98 mm; common coins (US quarter 24.26 mm, €1 23.25 mm, €2 25.75 mm, £1 23.43 mm); ruler markings; phones (146–163 × 70–78 mm, varies). | 0.6–0.85 |
| `typical-size` | A prior for this kind of object ("a phone stand is ~80 mm wide"). | at most 0.5 (enforced) |

The pipeline stops with `needsAnswers` when Gemini wrote questions, the lowest confidence is under **0.75 for mechanical parts** or **0.4 for decorative** ones, and the user has not already answered or confirmed the size. With `skipQuestions`, the build goes ahead and adds `MX-P3D-053` for any axis under 0.5.

Limits to tell users:

- **One photo cannot give true scale.** Without a reference object or a measurement, sizes are educated guesses. Perspective also distorts: a card nearer the camera than the part makes the part look smaller. Put the reference flat, beside the part, at the same distance, and shoot straight on.
- Reference objects give roughly **±5–10 %** at best. That is good enough for a figurine, not for a press fit. For anything that must fit, ask for calipers: hole diameters, slot widths, thicknesses.
- **Broken parts:** Gemini infers the complete part from the pieces. Missing geometry is a guess, and the spec says so in `notes`.
- **OpenSCAD's ±3 % check confirms the overall box, not every feature.** Hole positions and wall thicknesses follow the spec but are not measured back.
- Meshy matches one dimension exactly; the other two follow its proportions. Meshy is not suitable for parts that must mate with something.
- Scan units are a heuristic when the app doesn't record them. Always look at `report.scan` and `warnings`.

---

## Error codes (`MX-P3D-nnn`)

The tens digit groups the area. Codes are stable; the coordinator will fold them into the shared error registry. `P3D_ERRORS[code]` gives `{ key, retryable, message }`.

| Code | Key | Retry? | Meaning |
|---|---|---|---|
| MX-P3D-001 | INPUT_INVALID | no | Missing description/photos, or a file that is not a JPEG/PNG/WebP/HEIC |
| MX-P3D-002 | INPUT_TOO_LARGE | no | A photo over 20 MB, or more than 14 MB in total |
| MX-P3D-010 | GEMINI_NOT_CONFIGURED | no | `GEMINI_API_KEY` missing |
| MX-P3D-011 | GEMINI_HTTP | yes | Gemini HTTP error |
| MX-P3D-012 | GEMINI_NETWORK | yes | Network error / timeout |
| MX-P3D-013 | GEMINI_BAD_RESPONSE | yes | Answer not the expected JSON (or no usable dimensions) |
| MX-P3D-014 | GEMINI_BLOCKED | no | Safety block / empty answer |
| MX-P3D-015 | GEMINI_RATE_LIMITED | yes | HTTP 429 / quota |
| MX-P3D-020 | MESHY_NOT_CONFIGURED | no | `MESHY_API_KEY` missing |
| MX-P3D-021 | MESHY_BAD_REQUEST | no | 400/404/422: bad image or option |
| MX-P3D-022 | MESHY_AUTH | no | 401 |
| MX-P3D-023 | MESHY_NO_CREDITS | no | 402: insufficient credits / free plan |
| MX-P3D-024 | MESHY_MODERATION | no | 403: moderation blocked an image |
| MX-P3D-025 | MESHY_RATE_LIMITED | yes | 429 |
| MX-P3D-026 | MESHY_HTTP | yes | Other HTTP / network error |
| MX-P3D-027 | MESHY_TASK_FAILED | yes | Task FAILED/CANCELED (refunded) |
| MX-P3D-028 | MESHY_TIMEOUT | yes | Not done in 20 min; resume with `resumeMeshyTask` |
| MX-P3D-029 | MESHY_NO_MODEL | no | No GLB/STL, download failed, or unreadable model |
| MX-P3D-030 | OPENSCAD_MISSING | no | `openscad` not installed (`sudo apt install openscad`) |
| MX-P3D-031 | OPENSCAD_UNSAFE | yes | Every attempt failed the safety checks |
| MX-P3D-032 | OPENSCAD_COMPILE_FAILED | yes | Still not compiling after 3 attempts |
| MX-P3D-033 | OPENSCAD_TIMEOUT | yes | Rendering exceeded the timeout |
| MX-P3D-034 | OPENSCAD_EMPTY | yes | No geometry produced |
| MX-P3D-035 | OPENSCAD_NO_SPEC | no | No design spec to build from |
| MX-P3D-040 | SCAN_UNSUPPORTED | no | Not OBJ/PLY/STL/GLB |
| MX-P3D-041 | SCAN_PARSE_FAILED | no | Corrupt file or unsupported variant |
| MX-P3D-042 | SCAN_NO_FACES | no | Point cloud: export a mesh |
| MX-P3D-043 | SCAN_UNITS_UNCERTAIN | — | Warning: units guessed |
| MX-P3D-050 | DIMENSION_MISMATCH | — | Warning: size off by more than the tolerance |
| MX-P3D-051 | EXCEEDS_BUILD_VOLUME | — | Warning: larger than 220 × 220 × 220 mm |
| MX-P3D-052 | MESH_NOT_PRINTABLE | — | Warning: validation found blocking issues |
| MX-P3D-053 | DIMENSIONS_UNCERTAIN | — | Warning: low-confidence estimate used |
| MX-P3D-090 | CANCELLED | yes | `signal` aborted |
| MX-P3D-091 | ALL_ENGINES_FAILED | yes | Every engine failed (see `attempts`) |
| MX-P3D-092 | BUDGET_EXCEEDED | no | Meshy cost above `maxCredits` |
| MX-P3D-099 | INTERNAL | no | Unexpected error |

Codes 043 and 050–053 are only ever warnings, in `result.warnings`. All the others can be `result.error`, or appear in `attempts[].error` when a fallback took over.

---

## Configuration

| Variable | Default | Used for |
|---|---|---|
| `GEMINI_API_KEY` | — | Analysis and OpenSCAD code generation |
| `MORPHIX_GEMINI_VISION_MODEL` | `gemini-3.8-flash` | Gemini model (shared with the Guardian) |
| `MESHY_API_KEY` | — | Meshy engines |
| `MORPHIX_MESHY_IMAGE_MODEL` | `meshy-7.1` | `ai_model` for image tasks (`latest`, `meshy-6`, `meshy-6-lite`) |
| `MORPHIX_OPENSCAD_BIN` | `openscad` | Path to the OpenSCAD CLI |
| `MORPHIX_OPENSCAD_TIMEOUT_S` | `120` | Render timeout |
| `MORPHIX_PHOTO3D_MAX_CREDITS` | none | Refuse Meshy runs above this cost |

API details were checked on 2026-11-07 against docs.meshy.ai (Image to 3D, Multi-Image to 3D, Pricing) and the AI Studio model list. The Gemini docs now call `generateContent` "legacy", but it is still supported; it is the same call the Guardian uses.

---

## Integration steps (for the coordinator)

1. Merge the `photo3d` branch. It only adds files: `packages/photo3d/src/**`, `docs/PHOTO3D.md` and `tests/photo3d-*`. It has no new npm dependencies and imports only `@morphix/slicing` and `@morphix/shared`.
2. On the Pi: `sudo apt install openscad`. Optionally add the variables above to `config/morphix.env.example`.
3. Portal → main process: build `PhotoToModelRequest` from the upload (photos, description, measurements, reference object, optional scan). Call `photoToModel(request, { ...photo3dDepsFromEnv(env), onMeshyTask, signal }, onProgress)` in a job (`packages/jobs`). Stream progress to the portal.
4. On `needsAnswers`: show the questions and the estimated dimensions (editable). Call again with `analysis` plus `answers`, or with `analysis` plus `dimensionsMm`, which avoids another analysis call. Or call with `skipQuestions`.
5. On `done`: store `files.stl` (and `glb`/`scad`/`thumbnail`) as a new model version. Source `photo3d` or the engine name needs adding to `ModelVersion.source` in `@morphix/shared`. Then hand the STL to `preparePrint({ inputPath, upAxis: "z" })` **without** `targetHeightMm`, because the STL is already at real size. Show `warnings` (043/050–053) before printing.
6. Persist `onMeshyTask` ids per job. After a restart, call again with `resumeMeshyTask` so credits are not spent twice.
7. Fold `P3D_ERRORS` into the shared error registry (`packages/errors`). The keys, retryable flags and messages are already there.
8. Ask the user before spending credits. `meshyImageCost(options)` gives the price in advance, and `maxCredits` enforces it.
