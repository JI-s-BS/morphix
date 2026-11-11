# Voron

| Model | Sizes | Driver |
|---|---|---|
| 2.4 | 250, 300, 350 mm | `moonraker` |
| Trident | 250, 300, 350 mm | `moonraker` |
| V0.2 | 120 mm | `moonraker` |
| Switchwire | 250 × 210 mm | `moonraker` |

> **Status: not yet hardware-tested.** The Moonraker driver is implemented from the Moonraker API
> documentation. It has not been run on a real Voron yet.

Vorons are self-built, so each one is a little different. The catalog uses the standard kit
sizes and common limits (300 °C nozzle, 120 °C bed). If your build is very different (bigger bed,
other hotend), pick **Generic → Klipper printer** and enter your own size.

## Start and end G-code

The catalog uses the Voron convention: `PRINT_START EXTRUDER=... BED=...` and `PRINT_END`. Your
`printer.cfg` needs these macros (the Voron docs' sample config has them). Klipper ignores
parameters a macro does not use, so a bare `PRINT_START` macro still works. Your macro should do
the heating, homing, QGL / Z tilt and bed mesh.

## Connect

1. Find the printer's IP (Mainsail / Fluidd shows it, or your router).
2. Give Morphix access to Moonraker: add the Morphix machine to `trusted_clients` in
   `moonraker.conf`, or use an API key. See the
   [Moonraker steps in the generic guide](generic.md#klipper-printer-moonraker).

**In Morphix**: pick your Voron and size, type **Printer address**, **Port** `7125` (or `80`),
and **API key** if you use one.

## Common problems

- **"Auth" error**: the Morphix machine is not in `trusted_clients`, and no API key was given.
- **Print starts without heating**: your `PRINT_START` macro does not heat. Either heat in the
  macro (using the `EXTRUDER` and `BED` parameters) or add `M190` / `M109` lines before it in
  the slicer.
- **"Unknown command PRINT_START"**: add the macro to `printer.cfg`.

## Safety

- A Voron is only as safe as its build. Check thermal runaway (`verify_heater`) is on and the
  bed has a thermal fuse.
- Morphix limits the nozzle to 300 °C and the bed to 120 °C (110 °C on the V0.2).
