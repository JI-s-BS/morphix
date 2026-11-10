# Tronxy

| Model | Connection | Driver |
|---|---|---|
| X5SA Pro, X5SA-500 Pro | USB cable | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** The serial driver is implemented from the Marlin serial
> protocol. It has not been run on a real Tronxy printer yet.

Tronxy boards run Tronxy's own Marlin-like firmware. USB printing works with the standard Marlin
commands on most units, but some firmware versions are less reliable over USB than over the SD
card. Try a small print first.

## Connect

- Cable: USB data cable from the printer to the Morphix machine.
- **Serial port**: usually `/dev/ttyUSB0` or `/dev/ttyACM0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- Run the auto-leveling from the printer's menu once. The start G-code probes again with G29 after
  the bed is hot.

## Common problems

- **No answer on the serial port**: some Tronxy firmware uses `250000` baud. Change the speed and
  test again.
- **Print stops halfway over USB**: try a shorter cable, or update the printer's firmware from
  Tronxy's site.
- **USB port vanishes** (Ubuntu): `sudo apt remove brltty`.

## Safety

- Morphix limits the nozzle to 275 °C and the bed to 100 °C.
- The X5SA-500's 500 mm bed draws a lot of power. Do not leave it unwatched.
