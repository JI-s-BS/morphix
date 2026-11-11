# Slicer profiles: generated, ALL UNVERIFIED

Morphix no longer loads hand-written profiles. For every slice it generates the printer profile
from the printer's catalog entry (`packages/catalog`: bed size and shape, origin corner or
centre, nozzle, filament diameter, G-code flavor, start/end G-code, temperature limits, auto-level
command) with `packages/slicing/src/adapters/profile.ts`, and writes it next to the slice output.
When the catalog names a slicer's own vendor profile (`vendorProfiles`), the adapter uses that
instead and falls back to the generated one if the slicer refuses it (not for Bambu printers).

The files here are **snapshots** of what the generator makes for the Afinia QD330, the printer
Morphix was built on. `tests/slicers-profiles.test.ts` fails when they drift; regenerate with

    MORPHIX_WRITE_PROFILE_SNAPSHOTS=1 npx vitest run tests/slicers-profiles.test.ts

| File | Slicer | What it is |
|---|---|---|
| `qd330-pla-0.2mm.ini` | PrusaSlicer (`--load`) | printer + PLA + 0.2 mm print settings |
| `orcaslicer/qd330-machine.json` | OrcaSlicer / Bambu Studio (`--load-settings`) | machine |
| `orcaslicer/qd330-process-0.2mm.json` | OrcaSlicer / Bambu Studio (`--load-settings`) | process |
| `orcaslicer/qd330-pla.json` | OrcaSlicer / Bambu Studio (`--load-filaments`) | PLA filament |

None of these has been compared with output from the official Afinia slicer, and the start/end
G-code is a generic Marlin-style sequence (see `docs/QD330.md` on validating against a real .gx).
Nothing produced with them may be sent to the printer until validated.
