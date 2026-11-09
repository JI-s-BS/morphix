# Slicer profiles (Phase 3) — ALL UNVERIFIED

These profiles are **guesses** for the Afinia QD330 (0.4 mm nozzle, PLA 210/60 °C,
0.2 mm layers, 15 % infill, 220 mm cube). None has been compared with output from the
official Afinia slicer, and the start/end G-code is a generic Marlin-style placeholder.
Nothing produced with them may be sent to the printer until validated — see
`docs/PHASE3.md` ("Validating against a real .gx").

| File | Engine | Used by |
|---|---|---|
| `qd330-pla-0.2mm.ini` | PrusaSlicer CLI (`--load`) | `sliceStl` (preferred engine) |
| `orcaslicer/qd330-machine.json` | OrcaSlicer CLI (`--load-settings`) | `sliceStl` (fallback, experimental) |
| `orcaslicer/qd330-process-0.2mm.json` | OrcaSlicer CLI (`--load-settings`) | `sliceStl` |
| `orcaslicer/qd330-pla.json` | OrcaSlicer CLI (`--load-filaments`) | `sliceStl` |

The numeric defaults are duplicated in `packages/slicing/src/profiles.ts`
(`QD330_PLA_DEFAULTS`, used for the `.gx` header); `tests/phase3-slicer.test.ts`
checks the INI and the constants agree.
