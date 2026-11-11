# Printer setup guides

Morphix talks to your printer over your home network (LAN) or a USB cable. It never needs the
maker's cloud. Pick your brand below, follow its guide, then add the printer on Morphix's setup
page (**Setup → Printer**).

> **Honest status.** Only the **Afinia QD330** has been tested end to end on real hardware.
> Every other printer here is implemented from the maker's protocol documents (or the
> community's) and is **not yet hardware-tested**. It should work, but expect rough edges.
> If you try one, please report what worked and what did not (a GitHub issue is perfect).

## Support table

"Works" columns are what the driver is built to do, from the protocol docs. ✅ = supported,
— = the printer or protocol does not offer it, ⚠️ = depends on your setup (see the guide).

| Brand | Models in the catalog | Driver | Status | Upload | Start | Pause | Camera | Verified |
|---|---|---|---|---|---|---|---|---|
| [Afinia](afinia.md) | QD330 | `flashforge-tcp` | ✅ | ✅ | ✅ | ✅ | — | **tested** |
| [Bambu Lab](bambu-lab.md) | X1 Carbon, X1E, P1S, P1P, P2S, A1, A1 mini, H2D, H2S | `bambu-lan` | ✅ | ✅ | ✅ | ✅ | ⚠️ X1/H2: RTSP, P1/A1: snapshot | protocol |
| [Prusa](prusa.md) | MK4S, MK4, MK3.9, CORE One, MINI+, XL | `prusalink` | ✅ | ✅ | ✅ | ✅ | — | protocol |
| [Prusa](prusa.md) | MK3S+ | `marlin-serial` (or `octoprint`) | ✅ | streams | ✅ | ✅ | — | protocol |
| [Creality](creality.md) | K1, K1C, K1 Max, K1 SE, K2 Plus, K2 Pro, Hi, Ender-3 V3, Ender-3 V3 KE, CR-10 SE | `creality-k1` (or `moonraker` if rooted) | ✅ | ✅ | ✅ | ✅ | ⚠️ if it has a camera | protocol |
| [Creality](creality.md) | Ender-3, Ender-3 V2, V2 Neo, V3 SE, S1, S1 Pro, Ender-5 S1 | `marlin-serial` (or `octoprint`/`moonraker`) | ✅ | streams | ✅ | ✅ | — | protocol |
| [Elegoo](elegoo.md) | Centauri Carbon | `elegoo-sdcp` | ✅ | ✅ | ✅ | ✅ | ✅ MJPEG | protocol |
| [Elegoo](elegoo.md) | Neptune 4, 4 Pro, 4 Plus, 4 Max, OrangeStorm Giga | `moonraker` | ✅ | ✅ | ✅ | ✅ | ⚠️ if a webcam is set up | protocol |
| [Elegoo](elegoo.md) | Neptune 3 Pro | `marlin-serial` | ✅ | streams | ✅ | ✅ | — | protocol |
| [Anycubic](anycubic.md) | Kobra 3, Kobra 3 Max, Kobra S1, Kobra 2 Pro | `moonraker` (needs Rinkhals firmware) | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |
| [Anycubic](anycubic.md) | Kobra 2 Neo, Vyper | `marlin-serial` | ✅ | streams | ✅ | ✅ | — | protocol |
| [Sovol](sovol.md) | SV07, SV08 | `moonraker` | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |
| [Sovol](sovol.md) | SV06, SV06 Plus | `marlin-serial` | ✅ | streams | ✅ | ✅ | — | protocol |
| [QIDI](qidi.md) | X-Plus 3, X-Max 3, X-Smart 3, Q1 Pro, Plus4 | `moonraker` | ✅ | ✅ | ✅ | ✅ | ✅ MJPEG | protocol |
| [FlashForge](flashforge.md) | Adventurer 5M, 5M Pro, AD5X | `flashforge-http` | ✅ | ✅ | ✅ | ✅ | ⚠️ Pro / add-on camera | protocol |
| [FlashForge](flashforge.md) | Adventurer 3, Adventurer 4 | `flashforge-tcp` | ✅ | ✅ | ✅ | ✅ | — | protocol |
| [Snapmaker](snapmaker.md) | J1 / J1s, Artisan, 2.0 A350T, 2.0 A250T | `snapmaker` | ✅ | ✅ | ✅ | ✅ | — | protocol |
| [Ultimaker](ultimaker.md) | S3, S5, S7 | `ultimaker` | ✅ | ✅ | ✅ | ✅ | ✅ snapshot | protocol |
| [Voron](voron.md) | 2.4 (250/300/350), Trident (250/300/350), V0.2, Switchwire | `moonraker` | ✅ | ✅ | ✅ | ✅ | ⚠️ if a webcam is set up | protocol |
| [RatRig](ratrig.md) | V-Core 4 (300/400/500), V-Minion | `moonraker` | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |
| [Artillery](artillery.md) | Sidewinder X4 Pro, X4 Plus | `moonraker` | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |
| [Artillery](artillery.md) | Sidewinder X3 Pro, X3 Plus, Genius Pro | `marlin-serial` | ✅ | streams | ✅ | ✅ | — | protocol |
| [Kingroon](kingroon.md) | KLP1 / KP3S Pro V2 | `moonraker` / `marlin-serial` | ✅ | ✅ | ✅ | ✅ | — | protocol |
| [Two Trees](two-trees.md) | SK1 / Sapphire Pro | `moonraker` / `marlin-serial` | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |
| [Flsun](flsun.md) | V400, T1 / T1 Pro, S1 / S1 Pro, Super Racer | `moonraker` (SR: `marlin-serial`) | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |
| [Tronxy](tronxy.md) | X5SA Pro, X5SA-500 Pro | `marlin-serial` | ✅ | streams | ✅ | ✅ | — | protocol |
| [Monoprice](monoprice.md) | Select Mini V2, MP10 / Voxel | `marlin-serial` / `flashforge-tcp` | ✅ | ✅ | ✅ | ✅ | — | protocol |
| [Geeetech](geeetech.md) | A10 Pro, A20, Mizar S | `marlin-serial` | ✅ | streams | ✅ | ✅ | — | protocol |
| [Generic](generic.md) | Marlin (USB), Klipper (Moonraker), OctoPrint, RepRapFirmware (Duet) | `marlin-serial`, `moonraker`, `octoprint`, `duet` | ✅ | ✅ | ✅ | ✅ | ⚠️ | protocol |

"streams" means a USB printer: Morphix sends the G-code line by line while it prints, so the
Morphix machine must stay on and connected until the print ends.

### Not supported

| Brand | Model | Why |
|---|---|---|
| AnkerMake | M5 / M5C | No documented local protocol. Printing goes through Anker's cloud and app. |
| Raise3D | Pro2 / Pro3 / E2 | Uses Raise3D's own RaiseTouch API; Morphix has no driver for it yet. |
| Bambu Lab | any, in cloud mode | Morphix needs LAN mode. See the [Bambu Lab guide](bambu-lab.md). |

Your printer is not listed? If it runs **Marlin** and has a USB port, use **Generic → Marlin
printer (USB)**. If it runs **Klipper**, use **Generic → Klipper printer**. If you already use
**OctoPrint**, use **Generic → Any printer on OctoPrint**. The setup page lets you type your own
bed size for these.

## Why these 20 brands

We picked the brands with the most home users in 2025–2026, judged by sales rankings, the size of
their user communities (Reddit, Discord, Printables), and how many slicer profiles exist for them:

1. **Bambu Lab, Creality, Prusa, Elegoo, Anycubic**: the five biggest sellers to home users.
2. **Sovol, QIDI, FlashForge, Snapmaker, Artillery, Kingroon, Two Trees, Flsun, Tronxy,
   Monoprice, Geeetech**: large, active user bases and cheap, popular machines.
3. **Voron and RatRig**: the most built DIY (self-assembled) printers, all on Klipper.
4. **Ultimaker**: very common in schools, libraries and offices.
5. **Afinia**: Morphix's home printer, the QD330, and the only one tested on real hardware.

Left out: **AnkerMake** (no local protocol, see above), **Raise3D** (no driver yet, mostly
professional users), **Longer** (smaller user base; its Marlin machines work with Generic Marlin).

## The setup page, in short

1. Open `http://<morphix-machine>:8080` and sign in as admin.
2. Go to **Setup → Printer**. Search for your model (for example `ender 3 v2` or `p1s`).
3. Fill in the fields the page asks for (IP address, access code, API key, serial port ...).
   Your brand's guide says where to find each one on the printer.
4. Press **Test connection**. A green result shows the printer's name and firmware. A red result
   says what went wrong and what to try next.
5. Save. Secrets (access codes, API keys, passwords) are stored on the Morphix machine only and
   are shown afterwards only as "set".

## Safety, for every printer

- Morphix never starts, heats or moves a printer unless you ask it to.
- It never sets a temperature above the catalog's limit for your model.
- Check the bed is clear before you start a print, and do not leave a printer running unwatched
  for long. A 3D printer is a heater.
- Keep Morphix and your printer on your own network. Do not forward printer ports to the internet.
- Treat access codes and API keys like passwords. Anyone on your network with them can control the
  printer.

## Finding the printer's IP address

Every network guide asks for the printer's IP address (like `192.168.1.42`). Find it on the
printer's screen (usually **Settings → Network** or **About**) or in your router's list of
connected devices. Tip: in your router, give the printer a **fixed (reserved) IP** so it does not
change after a restart.

## USB printers: the basics

- Use a **data** USB cable. Many cheap cables only charge. If the printer never shows up, try
  another cable.
- Plug it straight into the Morphix machine, not through an unpowered hub.
- Let Morphix's user use serial ports: `sudo usermod -aG dialout $USER` (on Arch: `uucp`), then
  log out and back in. The installer does this for the `morphix` service user.
- On Ubuntu, the `brltty` package grabs CH340 USB chips (used by many Creality and other boards).
  If the port disappears a second after you plug in, run `sudo apt remove brltty`.
- Pick the port named `/dev/serial/by-id/...` if offered: it stays the same after a reboot.
  Otherwise it is usually `/dev/ttyUSB0` or `/dev/ttyACM0`.
