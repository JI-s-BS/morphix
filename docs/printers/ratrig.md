# RatRig

| Model | Sizes | Driver |
|---|---|---|
| V-Core 4 | 300, 400, 500 mm | `moonraker` |
| V-Minion | 180 mm | `moonraker` |

> **Status: not yet hardware-tested.** The Moonraker driver is implemented from the Moonraker API
> documentation. It has not been run on a real RatRig yet.

RatRig printers run **RatOS** (Klipper + Moonraker + Mainsail).

## Start and end G-code

The catalog uses the RatOS macros: `START_PRINT EXTRUDER_TEMP=... BED_TEMP=...` and `END_PRINT`.
RatOS ships both. They heat, home, level and purge.

## Connect

1. Find the printer's IP: open `http://ratos.local` or check your router.
2. RatOS trusts devices on your local network by default, so no API key is usually needed. If you
   changed that, see the [Moonraker steps in the generic guide](generic.md#klipper-printer-moonraker).

**In Morphix**: pick your model and size, type **Printer address**, leave **Port** at `7125` and
**API key** empty.

## Common problems

- **"Unreachable" at port 7125**: some RatOS setups only expose Moonraker through port `80`.
- **IDEX V-Core 4**: Morphix sends single-head prints for now (T0).
- **Print size wrong**: pick the right size variant (300 / 400 / 500).

## Safety

- Morphix limits the nozzle to 300 °C and the bed to 120 °C (110 °C on the V-Minion).
- Large beds take a long time to heat and draw a lot of power. Do not leave them unwatched.
