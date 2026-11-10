# Flsun

| Model | Build size (round) | Connection | Driver |
|---|---|---|---|
| V400 | Ø 300 × 410 mm | Wi-Fi (Klipper + Moonraker) | `moonraker` |
| T1 / T1 Pro | Ø 260 × 330 mm | Wi-Fi (Klipper + Moonraker) | `moonraker` |
| S1 / S1 Pro | Ø 320 × 430 mm | Wi-Fi (Klipper + Moonraker) | `moonraker` |
| Super Racer (SR) | Ø 260 × 330 mm | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`, `moonraker`) |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Moonraker API and the Marlin serial protocol). They have not been run on a real Flsun printer
> yet.

Flsun printers are **deltas**: the bed is round and (0,0) is the **middle** of the bed. The
catalog knows this; make sure you pick the Flsun model (not a Generic one) so prints land in the
center.

## V400, T1, S1 (Klipper)

1. Join your Wi-Fi from the screen and write down the **IP address**.
2. Check `http://<ip>` opens the web page (Mainsail / Fluidd, or FLSUN OS's page). Stock firmware
   does not need an API key.

**In Morphix**: pick your model, type the **Printer address**, leave **Port** at `7125` and
**API key** empty.

## Super Racer (USB)

- Cable: USB data cable to the Morphix machine.
- **Serial port**: usually `/dev/ttyUSB0` or `/dev/ttyACM0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- Run the delta calibration and bed leveling from the printer's menu before the first print.

## Common problems

- **Print is off-center or starts outside the bed**: a corner-origin profile was used. Pick the
  Flsun model so the center origin is set.
- **T1 / S1 "unreachable" on 7125**: some FLSUN OS versions only expose Moonraker on port `80`.

## Safety

- Deltas move very fast (the S1 up to 1200 mm/s). Keep hands out of the frame while it runs.
- Morphix limits the nozzle to 300 °C (350 °C on the S1, 260 °C on the SR) and the bed to 110 °C
  (120 °C on the S1, 100 °C on the SR).
