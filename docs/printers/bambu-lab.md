# Bambu Lab

| Model | Notes |
|---|---|
| X1 Carbon, X1E | Built-in storage; camera over RTSPS |
| P1S, P1P, P2S | Needs a microSD card in the printer for uploads |
| A1, A1 mini | Needs a microSD card in the printer for uploads |
| H2D, H2S | Built-in storage; camera over RTSPS |

Driver: `bambu-lan`. Morphix talks to the printer directly: MQTT over TLS (port 8883) for status
and commands, FTPS (port 990) to upload the sliced `.gcode.3mf`. No Bambu cloud account is used.

> **Status: not yet hardware-tested.** This driver is implemented from Bambu Lab's published LAN
> protocol and the community's documentation. It has not been run on a real Bambu printer yet.

## Before you start

- Update the printer's firmware from its screen first. Bambu changes the LAN rules in updates.
- For P1, P2 and A1 printers: put a microSD card in the printer. Uploads go to that card.

## Turn on LAN mode and Developer Mode

1. On the printer's screen open **Settings** (gear icon) → **Network** (WLAN) and connect to your
   Wi-Fi if you have not already. Write down the **IP address** shown there.
2. Turn on **LAN Only Mode**. (On some firmware this is under **Settings → General**.)
3. On firmware from 2025 onwards, Bambu added "authorization control". Third-party programs can
   only control the printer when **Developer Mode** is on. It appears as a switch under LAN Only
   Mode once LAN Only Mode is on. Turn it on.
   - Without Developer Mode, Morphix can usually read status but the printer refuses uploads and
     start commands.
4. The same screen shows the **Access Code** (8 characters). Write it down. It changes whenever
   you turn LAN mode off and on again.
5. Find the **Serial number**: **Settings → Device** (or **About**) on the screen, or the sticker
   on the back. It looks like `01P00A123456789`.

Note: in LAN Only Mode the Bambu Handy app and cloud printing stop working. That is expected.

## What to type into Morphix

On **Setup → Printer**, search for your model (for example `p1s`) and fill in:

- **Printer address**: the IP from step 1.
- **Access code**: from step 4. It is stored as a secret and never shown again.
- **Serial number**: from step 5.

Press **Test connection**. You should see the model, firmware and serial number.

## Common problems

- **"Auth" error**: the access code is wrong or has changed. Read it again from the screen.
- **Status works but uploads or start fail**: turn on **Developer Mode** (step 3).
- **Upload fails on P1/A1**: no microSD card, or the card is full or not FAT32/exFAT.
- **"Unreachable"**: the printer and Morphix are on different networks, or the router blocks
  devices from talking to each other ("client isolation" / guest network). Turn that off.
- **Camera shows nothing**: P1 and A1 printers only offer still snapshots; X1 and H2 stream.
  Some firmware needs **LAN Mode Liveview** turned on in the camera settings.

## Safety

- Bambu printers start moving the moment a print starts (homing, bed leveling, purge). Check the
  build plate is empty and the right plate type is in.
- Morphix limits temperatures to the model's limits (300 °C nozzle on most, 350 °C on H2).
- Keep the access code private: anyone on your network with it can control the printer.
