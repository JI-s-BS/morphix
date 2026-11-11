# Geeetech

| Model | Connection | Driver |
|---|---|---|
| A10 Pro, A20, Mizar S | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** The serial driver is implemented from the Marlin serial
> protocol. It has not been run on a real Geeetech printer yet.

## Connect

- Cable: USB data cable from the printer to the Morphix machine.
- **Serial port**: usually `/dev/ttyUSB0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- The A10 Pro and A20 have no bed probe in stock form: level the bed by hand. The Mizar S probes
  with G29 after the bed is hot.

If you added a 3D Touch / BLTouch probe to an A10 Pro or A20, pick **Generic → Marlin printer**
and add `G29` after `M190` in the start G-code.

## Common problems

- **USB port vanishes** (Ubuntu): `sudo apt remove brltty`.
- **Printer resets when Morphix connects**: normal for these boards; wait a few seconds and test
  again.

## Safety

- Morphix limits the nozzle to 250 °C (260 °C on the Mizar S) and the bed to 100 °C.
- Update old Geeetech firmware: some early versions had weak thermal runaway protection.
