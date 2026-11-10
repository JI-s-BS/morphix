# QIDI

| Model | Connection | Driver |
|---|---|---|
| X-Plus 3, X-Max 3, X-Smart 3, Q1 Pro, Plus4 | Wi-Fi / Ethernet (Klipper + Moonraker) | `moonraker` |

> **Status: not yet hardware-tested.** The Moonraker driver is implemented from the Moonraker API
> documentation. It has not been run on a real QIDI printer yet.

QIDI's current printers run Klipper with Moonraker and a Fluidd web page. QIDI Studio and Orca
use the same API.

## Put it on the network

1. On the screen open **Settings → Network**, join your Wi-Fi (or plug in Ethernet).
2. Write down the **IP address**.
3. Check `http://<ip>` (or `http://<ip>:10088` on some X-3 firmware) opens Fluidd.
4. Stock QIDI firmware does not need an API key.

## What to type into Morphix

Pick your model, type the **Printer address**, leave **Port** at `7125` and **API key** empty.
Press **Test connection**.

## Common problems

- **"Unreachable" on port 7125**: try port `80`.
- **Test works but uploads fail**: the internal storage is full. Delete old files in Fluidd.
- **Chamber heater**: Morphix does not set the chamber temperature itself; the slicer profile and
  the printer's own start macro do.

## Safety

- QIDI hotends reach 350 °C (370 °C on the Plus4). Morphix limits them to those values.
- The bed is limited to 120 °C (110 °C on the X-Smart 3).
- Keep the door closed while printing; the chamber gets hot.
