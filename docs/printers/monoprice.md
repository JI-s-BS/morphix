# Monoprice

| Model | Connection | Driver |
|---|---|---|
| Select Mini V2 | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |
| MP10 | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |
| Voxel | Wi-Fi / Ethernet (FlashForge TCP protocol, port 8899) | `flashforge-tcp` |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Marlin serial protocol, FlashForge's TCP protocol). They have not been run on a real Monoprice
> printer yet.

## Select Mini V2 and MP10 (USB)

- Cable: micro-USB (Select Mini) or USB-B (MP10) data cable to the Morphix machine.
- **Serial port**: usually `/dev/ttyACM0` or `/dev/ttyUSB0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- The Select Mini has no bed probe: level it by hand. The MP10 probes with G29 after heating.

## Voxel

The Voxel is a FlashForge Adventurer 3 inside. It uses FlashForge `.gx` files with (0,0) in the
middle of the bed; Morphix makes these for you.

1. Join your network from **Settings → Wi-Fi** and write down the **IP address**.

**In Morphix**: pick **Monoprice Voxel**, type the **Printer address**, leave **Port** at `8899`.

## Common problems

- **Select Mini bed never reaches temperature**: its bed tops out around 60 °C. Print PLA.
- **Voxel "busy"**: FlashPrint is connected. Close it.

## Safety

- Morphix limits the Select Mini to 250 °C nozzle and 60 °C bed, the MP10 to 250 °C / 100 °C and
  the Voxel to 240 °C / 100 °C.
