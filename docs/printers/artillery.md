# Artillery

| Model | Connection | Driver |
|---|---|---|
| Sidewinder X4 Pro, Sidewinder X4 Plus | Wi-Fi (Klipper + Moonraker) | `moonraker` |
| Sidewinder X3 Pro, Sidewinder X3 Plus, Genius Pro | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Moonraker API and the Marlin serial protocol). They have not been run on a real Artillery
> printer yet.

## Sidewinder X4 Pro and X4 Plus (Klipper)

1. Join your Wi-Fi from the screen and write down the **IP address**.
2. Check `http://<ip>` opens Mainsail. Stock firmware does not need an API key.

**In Morphix**: pick your model, type the **Printer address**, leave **Port** at `7125` and
**API key** empty.

## Sidewinder X3 and Genius Pro (USB)

- Cable: USB-B data cable to the Morphix machine.
- **Serial port**: usually `/dev/ttyACM0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- The start G-code probes the bed with G29 after the bed is hot.

## Common problems

- **USB keeps disconnecting**: the X3 boards are sensitive to cheap cables. Use a short shielded
  one.
- **X4 "unreachable" on 7125**: try port `80`.

## Safety

- Morphix limits the nozzle to 300 °C (250 °C on the Genius Pro) and the bed to 100 °C.
- The X3 Plus and X4 Plus have tall frames: keep the area above the gantry clear.
