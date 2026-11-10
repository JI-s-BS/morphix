# Slicers (GOAL.md item 2): notes for the server and integration

Branch `claude/op-slicers-86b0ab`. Owns `packages/slicing/**`, `config/slicer-profiles/**`.
The contract in `packages/slicing/src/adapters/types.ts` is unchanged.

## What's there

`packages/slicing/src/adapters/`

| File | What |
|---|---|
| `prusaslicer.ts`, `orcaslicer.ts`, `bambustudio.ts` (+ `orcafamily.ts`, shared Orca/Bambu CLI) | the three `SlicerAdapter`s |
| `index.ts` | `SLICERS`, `detectAll()`, `pickSlicer()`, `unsupportedReason()`, `slicerOrder()` |
| `detect.ts` | finding installs on any Linux, headless wrapping, `commandFor()` |
| `profile.ts` | profiles generated from a catalog `PrinterModel` |
| `output.ts` | post-processing and packaging in `printer.fileFormat` |
| `hints.ts` | `installHint` text per distro / arch |
| `zip.ts` | reads the plate G-code out of a `.gcode.3mf` for the preview |

The adapters accept a wider job / options than the contract (`MorphixSliceJob`: `printableDir`,
`baseName`, `leveling`, `thumbnailBmp`, `useVendorProfile`; `DetectOptions`: `searchPath`, `env`,
`fs`, `skipVersion`, `flatpak`, `headless`) and return `MorphixSliceOutput`. Both are assignable to
the contract types.

### Detection (`detect()`)
The order is: custom path, then `$MORPHIX_PRUSA_SLICER` / `$MORPHIX_ORCA_SLICER` / `$MORPHIX_BAMBU_STUDIO`, then `$PATH` (+ `/usr/bin`,
`/usr/local/bin`, `/snap/bin`) names `prusa-slicer PrusaSlicer orca-slicer OrcaSlicer bambu-studio BambuStudio …`,
then `/opt/<Slicer>[/bin]`, then `*.AppImage` in `~/Applications`, `~/.local/bin`, `/opt`, `/opt/*`, and last Flatpak
(`flatpak list --app` → `flatpak run com.prusa3d.PrusaSlicer | io.github.softfever.OrcaSlicer | com.bambulab.BambuStudio`).
`via` is `apt` when `/var/lib/dpkg/info/prusa-slicer.list` exists. If the custom path is wrong, detection falls back to the
search and adds a note.

Headless:
- An AppImage without FUSE (`/dev/fuse` + `fusermount[3]`) runs with `--appimage-extract-and-run`.
- OrcaSlicer and Bambu Studio start GTK even in CLI mode. With no `DISPLAY` / `WAYLAND_DISPLAY`
  they are wrapped in `xvfb-run -a` when that is installed; otherwise a note says to install `xvfb`.
- PrusaSlicer's `--export-gcode` needs no display.
- Flatpak gets `--filesystem=<job dir>` and `--filesystem=<model dir>` on every run, because the
  sandbox can't see `/tmp` or the data dir.

All of this is in the install's `notes`. **For install:** the systemd service has `HOME=<data dir>`,
so `~/Applications` means `<data dir>/Applications`. Tell users to put AppImages in `/opt`, or to
set the custom path on the setup page. Also install `xvfb` if Orca or Bambu Studio is wanted.

### Profiles (generated, UNVERIFIED)
These come from the catalog fields: bed size and shape (circles become a 32-point polygon, and the fit check uses the
inscribed square), origin (`--center` 0,0 vs x/2,y/2), nozzle, filament diameter, flavor (PrusaSlicer:
Klipper → `marlin2`, because Debian/RPi OS ship PrusaSlicer 2.5 with no klipper flavor; Orca: `klipper`),
`startGcode`/`endGcode` (PrusaSlicer placeholders, translated for Orca), max temperatures (filament clamped, with a warning),
`heatedBed`, `maxSpeedMmS` (default 150 when unset; 600 for the QD330), and `autoLevel`.

Without catalog start G-code, Morphix writes its own sequence:
1. heat
2. home
3. lift
4. wait for the bed
5. `;MORPHIX_LEVEL_BED` (only with `autoLevel`)
6. heat the nozzle
7. two purge lines along the front edge at 150 % flow (scaled for nozzle and filament)

Per-printer values the catalog has no field for are in `PRINTER_TUNING` (only the QD330 Z offset of −0.05 so far).

**QD330 behaviour is kept.** The generated PrusaSlicer profile has the same keys and values as the old hand-written `.ini`
(only the comments differ). The same goes for the leveling marker, G29, the first-layer caps, the fan off for 2 layers, the purge
line, the Z offset, the speed overlay, and smooth PEI (`High Temp Plate`). The OrcaSlicer machine start G-code now matches the
PrusaSlicer one (it gains `M107`, the FlashForge `T0`, and the Z30 lift).

`config/slicer-profiles/*` are now **snapshots** checked by `tests/slicers-profiles.test.ts`
(`MORPHIX_WRITE_PROFILE_SNAPSHOTS=1` regenerates them). `printing.ts` still reads the z_offset from the
`.ini`, which still works; `printerZOffsetMm(printer)` is the replacement.

Vendor profiles (`vendorProfiles`):
- **PrusaSlicer 2.6+:** `--printer-profile "<name>"`, plus Morphix's print and filament settings. `binary_gcode = 0`
  is added on 2.7+, because Prusa MK4/XL profiles default to `.bgcode`.
- **Orca / Bambu Studio:** the machine JSON only `inherits` the bundled printer (plus the Z offset).
- **Fallback:** if the slicer refuses the vendor profile, the adapter slices again with the generated profile and
  warns. There is no fallback for Bambu printers: Morphix won't guess Bambu start G-code, so a
  Bambu printer without `vendorProfiles` (and without `startGcode`) is unsupported.
- **Not run against real installs.** Vendor profile names come from the catalog. PrusaSlicer needs its vendor
  bundles in its data dir (the config wizard installs them).

### Output (`printer.fileFormat`)

| Format | Slicers | Morphix post-processing |
|---|---|---|
| `gcode` | all three | leveling + first-layer caps (plain flavors only) |
| `gx` | all three | same, then wrapped by `gx.ts` (thumbnail from the mesh) |
| `gcode.3mf` | Orca, Bambu Studio (`--export-3mf`) | **none**; plate G-code extracted only for the preview / estimates |
| `ufp` | none: `supports()` false | Cura's Griffin header is required (`unsupportedReason`) |

Leveling: the catalog's `autoLevel.gcode` replaces the marker. A catalog or vendor start G-code
without the marker is left alone ("handles bed leveling; Morphix added none"). `options.leveling`
(`MORPHIX_LEVELING` / `MORPHIX_LEVEL_GCODE`) still overrides the plan.

### pickSlicer
`pickSlicer(printer, installs, preferred?, env?)` returns `{ ok, adapter, install, warnings }`, or
`{ ok: false, reason: "slicer-not-installed" | "unsupported-printer", message }`.
- **Order:** the preferred slicer if it is installed and supports the printer; then slicers the catalog
  names a vendor profile for; then PrusaSlicer → Orca → Bambu Studio (Bambu printers: Bambu Studio → Orca).
- **The message:** it includes the install hints. Orca and Bambu Studio say plainly that they have no official arm64 Linux build.

## How the server should call it

```ts
import { findPrinter } from "@morphix/catalog";
import { preparePrint, prepareWithAdvice, detectAll, pickSlicer, SLICERS } from "@morphix/slicing";

const cfg = await store.load();                       // MorphixConfig
const conf = cfg.printers.find((p) => p.id === cfg.activePrinterId)!;
const printer = findPrinter(conf.modelId)!;           // PrinterModel

const r = await preparePrint({                         // or prepareWithAdvice (same options)
  inputPath, targetHeightMm,
  options: {
    printer,
    preferredSlicer: cfg.slicer.preferred,
    slicerPaths: cfg.slicer.paths,
    outputDir: join(dataDir, "jobs", jobId),            // not /tmp if a Flatpak slicer may be used
    filament, supports, layerHeightMm, infillPercent, speedMmS, zOffsetMm, leveling,
    onProgress,
  },
});
// The result shape is unchanged, plus:
//   r.printerId
//   r.printable: { ok: true, path, format } | { ok: false, reason, message }   <- send this file
//   r.files.printable
// r.gx is only produced for "gx" printers (otherwise { ok: false, reason: "not-gx" }).
// r.ok: the printable file exists (and a .gx validated).
// r.slicer.ok=false reasons: slicer-not-installed | unsupported-printer | slicer-failed | timeout | no-output | too-large | skipped.
```

For the setup page's "pick a slicer" step:
- `detectAll({ paths: cfg.slicer.paths })` gives every install with `version`, `via` and `notes`.
- `SLICERS[id].supports(printer)` / `unsupportedReason(id, printer)` say whether a slicer can make this printer's file.
- `SLICERS[id].installHint({ distro, arch })` (distro from `/etc/os-release` `ID`) tells the user how to install one.
- `pickSlicer(printer, installs, cfg.slicer.preferred)` shows which one will be used.

To slice directly without the mesh pipeline:
```ts
await SLICERS[install.id].slice(install, { modelPath, outDir, printer, filament: "pla" })
```

Defaults: with no `options.printer`, everything behaves as before for the Afinia QD330 (`defaultPrinter()`).
`profilesDir` is accepted and ignored (deprecated).

## Removed / changed API (slicing only)
- **Removed:** `sliceStl`, `detectSlicers`, `resolveProfilePaths`, `profilePathsIn`, `SlicerProfilePaths`, `writeOrcaMachineWithZ`.
  Use the adapters, `detectAll`, and `orcaMachineJson(printer, { zOffsetMm })`.
- **Removed, unused anywhere:** `cloneMesh`, `mulMat3`, `FIRST_LAYERS`, `FIRST_LAYERS_MAX_MMS`.
- **Kept:** the advisor (`advisor.ts`, `advised.ts`), which is used by `apps/desktop/electron/printing.ts`.
- **Changed:** `SlicerKind` is now `SlicerId` (adds `bambustudio`). `SlicerInfo` may carry `baseArgs` / `via`.
  `toSlicerInstall` / `toSlicerInfo` convert between the two.
- **Changed:** the Orca filament JSON name dropped "QD330". `clampSpeed`, `prusaSpeedConfig`, `orcaSpeedConfig`, `writePrusaSpeedIni` and
  `filamentSpeedLimit` take an optional printer maximum (default: the QD330's 600 mm/s).
- **Updated:** warnings now point at `docs/QD330.md` / `docs/SAFETY.md` (cleanup deleted PHASE3/PHASE5).

## Checked against the catalog branch
The generator ran over all 105 models on `claude/op-catalog-13ccbe` (temporary local copy, not committed).
- Every model generates a profile.
- Bambu printers go to Bambu Studio / Orca.
- Ultimaker `.ufp` is refused with the Cura reason.
- Everything else is sliceable.
- Catalog `START_PRINT` macros without the marker are left to do their own leveling.

## Not verified
- None of the three slicers was run here; every argument list comes from the CLIs' documentation and source.
  This covers `--printer-profile`, `--arrange`, `--export-3mf`, Flatpak `--filesystem` for host `/tmp` subdirectories,
  and xvfb. Tests use a fake exec.
- No generated profile has printed on a real printer. The QD330 `.gx` remains UNVERIFIED (docs/QD330.md).

## Known test failure, not from this branch
`tests/portal-api.test.ts` fails in this worktree with a three.js 404. The worktree has no local node_modules, and the test
fails the same way on the base commit.
