# Generic printers

Use these when your exact model is not in the catalog. You type your own bed size on the setup
page.

| Catalog entry | For | Driver |
|---|---|---|
| Marlin printer (USB) | Any Marlin printer with a USB port | `marlin-serial` (alt: `octoprint`) |
| Klipper printer (Moonraker) | Any Klipper printer with Moonraker (Mainsail / Fluidd) | `moonraker` |
| Any printer on OctoPrint | Any printer you already run through OctoPrint | `octoprint` |
| RepRapFirmware printer (Duet) | Duet 2 / Duet 3 boards, RepRapFirmware 3 | `duet` |

> **Status: not yet hardware-tested.** These drivers are implemented from the published
> protocols (Marlin serial, Moonraker API, OctoPrint REST API, RepRapFirmware HTTP API). They have
> not been run on real hardware with Morphix yet.

## Bed size, shape and origin

The Generic entries start at 220 × 220 × 250 mm. On the setup page enter your printer's real
**build size** (X, Y, Z in mm, 50–2000). For a **delta** (round bed) choose **round** and enter
the diameter; (0,0) is then the middle of the bed. Get this right: a wrong size can make the
nozzle hit the frame.

The Generic start G-code heats the bed, homes, waits for the nozzle and draws a purge line on the
left edge. It does not probe the bed. If you have a probe, or a Klipper `PRINT_START` macro,
edit the start G-code in the slicer settings.

## Marlin printer (USB)

1. Connect a **data** USB cable from the printer to the Morphix machine.
2. Make sure the Morphix user is in the `dialout` group (Arch: `uucp`). See the
   [README](README.md#usb-printers-the-basics).
3. **In Morphix**: **Serial port** (pick `/dev/serial/by-id/...` if shown, else `/dev/ttyUSB0` or
   `/dev/ttyACM0`) and **Speed (baud)**: `115200` (some older boards use `250000`).

Morphix streams the G-code line by line, so keep the Morphix machine on until the print ends.

## Klipper printer (Moonraker)

1. Find the printer's IP (Mainsail or Fluidd shows it; or your router's device list).
2. Check `http://<ip>:7125/server/info` opens in a browser. If it does, Moonraker is reachable.
3. Access: Moonraker either trusts your network or wants an API key.
   - **Trusted clients** (simplest): in `moonraker.conf`, under `[authorization]`, add the
     Morphix machine's IP or your network (for example `192.168.1.0/24`) to `trusted_clients`,
     then restart Moonraker. Leave **API key** empty in Morphix.
   - **API key**: open `http://<ip>:7125/access/api_key` from a trusted device, or copy it from
     Mainsail/Fluidd settings. Paste it into **API key** in Morphix.
4. **In Morphix**: **Printer address** (IP), **Port** `7125` (or `80` if Moonraker sits behind
   nginx), **API key** if you use one.

## Any printer on OctoPrint

1. In OctoPrint open **Settings → Application Keys** (or **User Settings → Application Keys**).
2. Create a key named `Morphix` and copy it. (The global API key under **Settings → API** also
   works, but a separate key can be revoked on its own.)
3. **In Morphix**: **Printer address** (the OctoPrint IP or name), **Port** (`80`, or `5000` for a
   plain install), **API key**.
4. Pick the right bed size, because OctoPrint does not tell Morphix what printer is attached.

## RepRapFirmware printer (Duet)

1. Find the Duet's IP on its screen (PanelDue) or in your router.
2. Open `http://<ip>` and check Duet Web Control loads.
3. If you set a board password with `M551`, you need it. Otherwise leave **Password** empty.
4. **In Morphix**: **Printer address**, **Password** (only if set).

## Common problems

- **"Permission denied" on the serial port**: the `dialout` group change needs a fresh login (or
  a reboot) to take effect.
- **Moonraker "auth" error**: the Morphix machine is not in `trusted_clients` and no API key was
  given.
- **OctoPrint "auth" error**: the key was revoked or mistyped. Make a new one.
- **Print is offset or hits the frame**: wrong bed size or origin. Fix them on the setup page.

## Safety

- Generic models use cautious limits (Marlin and OctoPrint: 260 °C nozzle, 100 °C bed;
  Klipper and Duet: 280 °C / 110 °C). Your printer's own firmware limits still apply too.
- Your printer must have thermal runaway protection turned on in its firmware. Check before you
  print unwatched.
