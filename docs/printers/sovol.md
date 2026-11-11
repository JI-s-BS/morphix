# Sovol

| Model | Connection | Driver |
|---|---|---|
| SV07, SV08 | Wi-Fi / Ethernet (Klipper + Moonraker) | `moonraker` |
| SV06, SV06 Plus | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`, `moonraker`) |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Moonraker API and the Marlin serial protocol). They have not been run on a real Sovol printer
> yet.

## SV07 and SV08 (Klipper)

1. Join your network: the SV08 has Ethernet and Wi-Fi; set Wi-Fi on the screen or in Mainsail.
2. Write down the **IP address** (shown on the screen, or in your router).
3. Check `http://<ip>` opens Mainsail. Stock Sovol firmware does not need an API key.

**In Morphix**: pick your model, type the **Printer address**, leave **Port** at `7125` and
**API key** empty (unless you set one up; see the [generic guide](generic.md#klipper-printer-moonraker)).

## SV06 and SV06 Plus (USB)

- Cable: USB-C data cable to the Morphix machine.
- **Serial port**: usually `/dev/ttyACM0` or `/dev/ttyUSB0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- The start G-code probes the bed with G29 after the bed is hot.

## Common problems

- **SV08 "unreachable"**: Moonraker may only be reachable through port 80 on some images; try
  port `80`.
- **SV06 prints a purge line in the air**: the Z offset is not set. Set it on the printer first.
- **USB port vanishes** (Ubuntu): `sudo apt remove brltty`.

## Safety

- Morphix limits the nozzle to 300 °C and the bed to 100 °C on all Sovol models here.
- The SV08 moves fast (up to 700 mm/s). Keep hands out of the frame.
