# Two Trees

| Model | Connection | Driver |
|---|---|---|
| SK1 | Wi-Fi (Klipper + Moonraker) | `moonraker` |
| Sapphire Pro | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Moonraker API and the Marlin serial protocol). They have not been run on a real Two Trees
> printer yet.

## SK1

1. Join your Wi-Fi from the screen and write down the **IP address**.
2. Check `http://<ip>` opens the web page (Mainsail / Fluidd). Stock firmware does not need an
   API key.

**In Morphix**: pick **Two Trees SK1**, type the **Printer address**, leave **Port** at `7125`.

## Sapphire Pro (USB)

- Cable: USB data cable to the Morphix machine.
- **Serial port**: usually `/dev/ttyACM0` or `/dev/ttyUSB0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- The Sapphire Pro has no bed probe. Level the bed by hand before printing.

## Common problems

- **SK1 "unreachable" on 7125**: try port `80`.
- **Sapphire Pro first layer too high or low**: level the bed by hand; Morphix does not probe it.

## Safety

- Morphix limits the nozzle to 300 °C (250 °C on the Sapphire Pro) and the bed to 100 °C.
- The SK1 moves fast (up to 700 mm/s). Keep hands out.
