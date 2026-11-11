# Anycubic

| Model | Connection | Driver |
|---|---|---|
| Kobra 3, Kobra 3 Max, Kobra S1, Kobra 2 Pro | Wi-Fi, **needs the community Rinkhals firmware** | `moonraker` |
| Kobra 2 Neo, Vyper | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents (the
> Moonraker API and the Marlin serial protocol). They have not been run on a real Anycubic
> printer yet.

## Kobra 3, Kobra 3 Max, Kobra S1, Kobra 2 Pro

Anycubic's own firmware only talks to Anycubic's cloud and app. There is no documented local API.
To use these printers with Morphix you need **Rinkhals**, a community add-on firmware that adds
Moonraker (the standard Klipper API) on your local network. It is installed from a USB stick and
can be removed again.

1. Read the Rinkhals project page (github.com/jbatonnet/Rinkhals) and check your printer and
   firmware version are supported.
2. Install it as the project describes (copy the update file to a USB stick, plug it in, restart).
3. Join your Wi-Fi on the printer's screen and write down the **IP address**.
4. Check it works: open `http://<ip>` in a browser. You should see Mainsail or Fluidd.

**In Morphix**: pick your model and type the **Printer address**. Leave **Port** at `7125` and
**API key** empty unless you set one up.

Rinkhals is not made by Anycubic. Using it is your choice and may affect your warranty.

## Kobra 2 Neo and Vyper (USB)

- Cable: **USB-C** on the Kobra 2 Neo, **USB-B** on the Vyper. Use a data cable.
- **Serial port**: usually `/dev/ttyUSB0` or `/dev/ttyACM0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).
- Run auto-leveling once from the printer's menu so a mesh is saved; the start G-code loads it.

## Common problems

- **Kobra 3 / S1 "unreachable"**: Rinkhals is not running (the stock firmware started instead).
  Restart the printer and check the Rinkhals logo appears.
- **The ACE Pro color unit does not work**: Morphix prints with one filament for now.
- **USB port vanishes** (Ubuntu): `sudo apt remove brltty`.

## Safety

- Morphix limits the nozzle to 260–320 °C depending on the model, and the bed to 100–120 °C.
- With USB, keep the Morphix machine on until the print ends.
