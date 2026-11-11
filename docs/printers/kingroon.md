# Kingroon

| Model | Connection | Driver |
|---|---|---|
| KLP1 | Wi-Fi (Klipper + Moonraker) | `moonraker` |
| KP3S Pro V2 | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Moonraker API and the Marlin serial protocol). They have not been run on a real Kingroon
> printer yet.

## KLP1

1. Join your Wi-Fi from the screen and write down the **IP address**.
2. Check `http://<ip>` opens Mainsail or Fluidd. Stock firmware does not need an API key.

**In Morphix**: pick **Kingroon KLP1**, type the **Printer address**, leave **Port** at `7125`.

## KP3S Pro V2 (USB)

- Cable: USB data cable (Type-C) to the Morphix machine.
- **Serial port**: usually `/dev/ttyUSB0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).

If your KP3S runs Klipper (some versions ship with it), pick **Generic → Klipper printer** and
set the bed to 200 × 200 × 200 mm.

## Common problems

- **USB port vanishes** (Ubuntu): `sudo apt remove brltty`.
- **KLP1 "unreachable" on 7125**: try port `80`.

## Safety

- Morphix limits the nozzle to 300 °C (260 °C on the KP3S Pro V2) and the bed to 100 °C.
