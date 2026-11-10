# Catalog session notes (GOAL.md items 3 and 8)

## What is done

- `packages/catalog/src/printers.ts`: 105 `PrinterModel` entries, 20 brands + a Generic set.
  - Brands: Afinia, Bambu Lab, Prusa, Creality, Elegoo, Anycubic, Sovol, QIDI, FlashForge,
    Snapmaker, Ultimaker, Voron, RatRig, Artillery, Kingroon, Two Trees, Flsun, Tronxy, Monoprice,
    Geeetech. Why these: `docs/printers/README.md` ("Why these 20 brands").
  - Generic: `generic-marlin`, `generic-klipper`, `generic-octoprint`, `generic-duet`.
  - `afinia-qd330` is unchanged and is the only `verified: "tested"` entry.
  - `UNSUPPORTED_PRINTERS`: AnkerMake M5/M5C (no local protocol), Raise3D (no driver),
    Bambu in cloud mode. The setup page can show these with their reason.
- `packages/catalog/src/search.ts`: `searchPrinters(text)`, `printersByDriver(id, {includeAlt})`,
  `brands()`, `isGeneric()`, `withBedOverride(model, {x,y,z,shape,origin})` (Generic only, 50–2000
  mm, round bed forces center origin; throws `RangeError` with a plain message), `BED_LIMITS`.
  All exported from `@morphix/catalog`.
- `docs/printers/`: README with the support table + one guide per brand + `generic.md`. Each
  model's `setupDoc` points at its brand file. Every non-Afinia guide says it is not yet
  hardware-tested.
- Tests: `tests/catalog-printers.test.ts` (ids, drivers, beds, temps, origin, G-code sanity,
  docs exist and mention each model, README lists each brand) and `tests/catalog-search.test.ts`.

## For the integration session / other sessions

- **Driver connection fields.** The guides name the fields in plain words ("Printer address",
  "Access code", "Serial number", "Check code", "API key", "User name", "Password", "Serial port",
  "Speed (baud)", "Port"). The driver sessions had not written their `fields` yet when these
  guides were written. If a driver's labels differ, update the guide's "What to type into
  Morphix" section (catalog owns `docs/printers/**`).
- **Support table "works" columns** describe what each driver is designed to do from the
  protocol docs. Check them against each driver's real `capabilities()` after merge (camera
  especially).
- **vendorProfiles names are best effort.** They follow the slicers' naming patterns but were
  not checked against installed PrusaSlicer / Orca / Bambu Studio bundles. Slicer adapters must
  fall back to the generated profile when a name is not found.
- **Start G-code conventions** (Klipper printers rely on macros on the printer):
  Voron `PRINT_START EXTRUDER= BED=` / `PRINT_END`; RatRig and Creality OS
  `START_PRINT EXTRUDER_TEMP= BED_TEMP=` / `END_PRINT`. Marlin templates heat the bed, home,
  level after heating (G29, or `M420 S1` to load a saved mesh), wait for the nozzle, then two purge
  lines at X5; they end with `{if use_relative_e_distances}M83{else}M82{endif}`. Models with a
  vendor profile and no `startGcode` rely on that profile. Center-origin printers have no
  corner purge line (tested).
- **Anycubic Kobra 2 Pro / 3 / 3 Max / S1** are listed with `driver: "moonraker"` because stock
  firmware has no documented local API; the guide says they need the community Rinkhals firmware.
- **Contract wish (not changed):** `PrinterModel` has no field for "needs community firmware" or
  per-model connection hints (e.g. a default Moonraker port). A `notes?: string` field would
  let the setup page show "Needs Rinkhals" without reading the guide. Not urgent.
- `DriverId` is a type only; the test keeps a `Record<DriverId, true>` so typecheck fails if a
  driver id is added to the contract without updating the catalog test.
