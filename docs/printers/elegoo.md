# Elegoo

| Model | Connection | Driver |
|---|---|---|
| Centauri Carbon | Wi-Fi (Elegoo SDCP protocol) | `elegoo-sdcp` |
| Neptune 4, Neptune 4 Pro, Neptune 4 Plus, Neptune 4 Max, OrangeStorm Giga | Wi-Fi / Ethernet (Klipper + Moonraker) | `moonraker` |
| Neptune 3 Pro | USB cable (Marlin) | `marlin-serial` |

> **Status: not yet hardware-tested.** These drivers are implemented from protocol documents
> (Elegoo's open SDCP specification, the Moonraker API, the Marlin serial protocol). They have
> not been run on a real Elegoo printer yet.

## Centauri Carbon

The Centauri Carbon speaks SDCP over a WebSocket (port 3030). There is no password.

1. On the screen, open **Settings → Network** and join your Wi-Fi.
2. Write down the **IP address** shown there.

**In Morphix**: pick **Elegoo Centauri Carbon** and type the **Printer address** (the IP). Press
**Test connection**. Morphix may also find it automatically (SDCP answers a broadcast on UDP
port 3000).

The camera stream is offered by the printer at port 3031.

## Neptune 4 series and OrangeStorm Giga

These run Klipper with Moonraker and a Fluidd web page.

1. On the screen, join your Wi-Fi (**Settings → Network**) and write down the **IP address**.
2. Check it works: open `http://<ip>` in a browser. You should see Fluidd.
3. Stock Elegoo firmware does not require an API key. If you turned on Moonraker authorization
   yourself, create a key (see the [Moonraker steps in the generic guide](generic.md)).

**In Morphix**: pick your model and type the **Printer address**. Leave **Port** at `7125`.
Leave **API key** empty unless you set one up.

## Neptune 3 Pro (USB)

- Cable: USB-C data cable, from the printer to the Morphix machine.
- **Serial port**: usually `/dev/ttyUSB0`. **Speed (baud)**: `115200`.
- The Morphix user must be in the `dialout` group (see the [README](README.md#usb-printers-the-basics)).

## Common problems

- **Neptune 4 "unreachable" on port 7125**: some firmware only exposes Moonraker through port 80.
  Try port `80`.
- **Centauri Carbon test times out**: the printer only allows a few connections at once. Close
  Elegoo Slicer's device tab and try again.
- **USB port vanishes** (Ubuntu): `sudo apt remove brltty`.

## Safety

- The Neptune 4 and Centauri Carbon move at up to 500 mm/s. Keep hands out.
- Morphix limits the nozzle to 300 °C (320 °C on the Centauri Carbon) and the bed to 110 °C.
- The OrangeStorm Giga's huge bed draws a lot of power. Do not leave it unwatched.
