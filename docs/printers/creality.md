# Creality

| Model | Connection | Driver |
|---|---|---|
| K1, K1C, K1 Max, K1 SE, K2 Plus, K2 Pro, Hi, Ender-3 V3, Ender-3 V3 KE, CR-10 SE | Wi-Fi / Ethernet (Creality OS) | `creality-k1` (alt: `moonraker` if rooted) |
| Ender-3, Ender-3 Pro, Ender-3 V2, Ender-3 V2 Neo, Ender-3 V3 SE, Ender-3 S1, Ender-3 S1 Pro, Ender-5 S1 | USB cable (Marlin) | `marlin-serial` (alt: `octoprint`, `moonraker`) |

> **Status: not yet hardware-tested.** Both drivers are implemented from protocol documents
> (Creality OS's local WebSocket API and the Marlin serial protocol). They have not been run on
> a real Creality printer yet.

## Network printers (Creality OS: K1, K2, Hi, Ender-3 V3 / V3 KE, CR-10 SE)

These printers run Creality OS, which is based on Klipper. Morphix talks to the printer's local
WebSocket service (port 9999), the same one Creality Print uses on your LAN.

1. On the screen, open **Settings → Network** and join your Wi-Fi (K1 Max and K2 also have
   Ethernet). Write down the **IP address**.
2. That is all. No password or code is needed on stock firmware.

**Optional: Moonraker.** If you rooted the printer (**Settings → Root account** on K1-series
firmware) and installed Moonraker with a helper script, you can choose the `moonraker`
connection instead. Then follow the [Moonraker steps in the generic guide](generic.md).
Rooting voids support from Creality; only do it if you know why you want it.

### What to type into Morphix

On **Setup → Printer**, search for your model (for example `k1 max`) and fill in:

- **Printer address**: the IP from step 1.

Press **Test connection**.

## USB printers (Marlin: Ender-3 family, Ender-5 S1)

1. Use the right cable: **micro-USB** on Ender-3, Ender-3 Pro and Ender-3 V2;
   **USB-C** on Ender-3 S1, S1 Pro, V2 Neo, V3 SE and Ender-5 S1. It must be a data cable.
2. Plug it into the Morphix machine. Turn the printer on.
3. Make sure the Morphix user is in the `dialout` group (see the
   [README](README.md#usb-printers-the-basics)).

### What to type into Morphix

- **Serial port**: usually `/dev/ttyUSB0` (the Creality boards use a CH340 chip).
- **Speed (baud)**: `115200`.

Models with a probe (CR Touch / BL Touch, S1, V2 Neo, V3 SE) load the saved mesh or probe the bed
after heating. The plain Ender-3 and Ender-3 V2 have no probe: level the bed by hand first.

## Common problems

- **K1 test fails with "unreachable"**: some firmware turns the LAN service off until you have
  opened Creality Print once, or after a firmware update. Restart the printer and try again.
- **USB port vanishes after a second** (Ubuntu): remove `brltty` (`sudo apt remove brltty`).
- **Printer resets mid-print over USB**: a bad cable or USB power. Use a short, good cable.
  Some people put tape over the cable's 5 V pin so the printer does not get powered by USB.
- **Ender-3 V2 / Ender-3 ignore G29**: they have no probe in stock form. That is why Morphix does
  not send G29 to them.

## Safety

- Very old Ender-3 firmware had no thermal runaway protection. Update the firmware if your printer
  is from before 2019.
- The Ender-3 and V2 hotends are PTFE-lined: Morphix limits them to 250 °C.
- With USB, keep the Morphix machine on until the print ends.
- K1 and K2 printers move fast. Keep hands out while they run.
