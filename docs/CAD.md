# Claude + headless CAD (`@morphix/cad`)

Use this for functional, mechanical and fit-critical parts: phone cases, mounts, brackets, gears, hinges, enclosures, replacement parts, fidget spinners, simple robot-arm parts. Decorative models (people, toys, characters) go to Meshy instead.

How it works:

1. Claude (Messages API, plain `fetch`) writes **parametric OpenSCAD**: every key dimension is a named variable at the top. The part sits flat on Z = 0, fits the QD330's 220 × 220 × 220 mm build volume, prints without supports where possible, and follows 0.4 mm-nozzle rules (walls ≥ 1.2 mm, 0.2–0.4 mm fit clearances).
2. The code goes through the static safety checks from `@morphix/photo3d`: no `import`/`include`/`use`/`surface`/`file=`, bounded `$fn` and loops.
3. `openscad -o model.stl model.scad` renders it headlessly in a private temp dir. `execFile` is used, so there is no shell.
4. The STL is checked with `@morphix/slicing` (`parseStl`, `validateMesh`, `computeBounds`). It must be non-empty, have no open or non-manifold edges, not be inside-out, have few degenerate faces, fit inside 220 mm, be larger than a speck, and be within max(2 mm, 10 %) of the size Claude said it would be. A part that floats above the bed is dropped onto Z = 0.
5. If any step fails (an OpenSCAD error, empty output, a bad mesh, out of volume, a size mismatch, unsafe code, or a cut-off answer), the problem and the code go back to Claude. Default is 4 attempts. A size mismatch on the last attempt is still returned, with a warning note. Everything else ends in `MX-CAD-021`.

## API

```ts
import { cadDepsFromEnv, generateCadModel, CadError } from "@morphix/cad";

const result = await generateCadModel(
  {
    description: "iPhone 17 case with a cool design", // user's words
    dimensions: { "shaft diameter": 6 },              // optional, mm
    photoAnalysis,                                    // optional, any JSON (e.g. photo3d analysis)
    maxAttempts: 4,                                   // optional
  },
  { ...cadDepsFromEnv(process.env), onProgress: (stage, detail) => log(stage, detail), signal },
);
// result: {
//   stl: Buffer,            // binary/ASCII STL in mm, Z up, on Z = 0
//   scad: string,           // the parametric source (save it next to the STL)
//   sizeMm: {x, y, z},
//   notes: string[],        // printing tips + anything the checks changed
//   assumptions: string[],  // measurements that were assumed; see below
//   attempts: number,
//   device: {name, heightMm, widthMm, depthMm, source} | null,
//   fitCritical: boolean,
//   model: string, attemptLog, triangles, volumeMm3,
// }
```

The `onProgress` stages are `designing`, `rendering`, `checking`, `repairing` and `done`. `detail` is a short sentence you can show to the user.

The deps are `anthropicApiKey`, `model`, `effort`, `exec` (the `ExecFileFn` from `@morphix/slicing`), `openscadBin`, `openscadTimeoutMs` (default 300 s, because CGAL is slow on a Pi 4), `fetch`, `fallbacks`, `signal`, `onProgress` and `sleep`.

Errors are thrown as a `CadError` with a stable `code` and a `retryable` flag. The registry is `CAD_ERRORS` in `packages/cad/src/errors.ts`:

| Code | Meaning |
|---|---|
| MX-CAD-001 | No description given |
| MX-CAD-002 | `ANTHROPIC_API_KEY` missing |
| MX-CAD-003 | Cancelled through `signal` |
| MX-CAD-010 | Claude API HTTP error |
| MX-CAD-011 | API key rejected |
| MX-CAD-012 | Rate limited or overloaded |
| MX-CAD-013 | Network error |
| MX-CAD-014 | Claude declined |
| MX-CAD-015 | Bad model name or parameter |
| MX-CAD-020 | `openscad` not installed |
| MX-CAD-021 | No printable design within `maxAttempts`. `error.scad` holds the last code. |

## Measurements and honesty

- `devices.ts` has published **body** dimensions (height × width × thickness, without the camera bump) for recent iPhones (13–16, 16e, SE 3), Galaxy S24/S25 and Pixel 8/9. Each entry names its source. The values were copied from the manufacturers' spec pages and have not been re-measured.
- Camera, button and port positions are **never** in the table. Claude must state the ones it used in `assumptions`.
- Devices that are not in the table, such as **iPhone 17**, are flagged to Claude as unknown. Claude must list every dimension it relies on, with its confidence. If it lists none, Morphix adds "Measure your device before printing."
- **UI rule:** when `assumptions` is non-empty, show "Based on these measurements — check before printing" with the list. Never present a fit as exact unless the user gave the measurements.

## Environment

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Required. `cadConfigured(env)` checks for it. |
| `MORPHIX_CLAUDE_MODEL` | `claude-opus-5-5` | Model override. |
| `MORPHIX_CLAUDE_EFFORT` | `high` | One of `low`, `medium`, `high`, `xhigh`, `max`. |
| `MORPHIX_CLAUDE_FALLBACKS` | on | Set `0` to stop sending `fallbacks: "default"`. |
| `MORPHIX_OPENSCAD_BIN` | `openscad` | The Pi has `/usr/bin/openscad` (2021.01). |
| `MORPHIX_OPENSCAD_TIMEOUT_S` | 300 | Shared with photo3d. |

## Claude request

`POST https://api.anthropic.com/v1/messages` with the headers `x-api-key` and `anthropic-version: 2023-06-01`. The body sets:

- `stream: true` (SSE, read to the end, so long thinking never hits an HTTP timeout)
- `thinking: {type: "adaptive"}`
- `output_config: {effort, format: {type: "json_schema", schema}}`
- `max_tokens: 32000`

There is no `temperature`, which Opus 5.5 rejects. For models that support it (Opus 5.5/5, Fable 5.1, Sonnet 5.5), the request also sends `fallbacks: "default"` with `anthropic-beta: server-side-fallback-2026-07-01`. If a refusal is routed to a fallback model, the answer still arrives. If the API rejects the beta, the client retries once without it. The client also retries 429/5xx/529 and network errors twice with back-off, honouring `retry-after`. Each repair attempt is a fresh single-turn request that includes the last two failures and their code, so there is no thinking-block replay to manage.

## Integration (main session)

1. Call `generateCadModel` when Gemini routes a request to "Claude". Write `result.stl` and `result.scad` into the model version folder.
2. The STL is already at real size. Prepare it with `preparePrint({ inputPath, upAxis: "z" })` and **no** `targetHeightMm`.
3. Show `assumptions` (see the UI rule above) and `notes`. Offer "edit measurements": the variables at the top of `scad` can be changed and re-rendered with `runOpenscad` from photo3d.
4. `ModelVersion.source` (in shared) needs a new value, for example `"claude-cad"`. Fold `CAD_ERRORS` into packages/errors.
5. Add `ANTHROPIC_API_KEY` and `MORPHIX_CLAUDE_MODEL` to `config/morphix.env.example`. This package does not touch that file.

## Not verified

- No real Claude API call has been made from this package; the request shape follows the current API reference.
- OpenSCAD was not installed on the development machine. The real render test (`tests/cad-openscad-real.test.ts`) only runs where `openscad` is on PATH, such as on the Pi.
- The device numbers come from manufacturer spec sheets and have not been re-measured.
