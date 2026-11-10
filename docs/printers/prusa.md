# Prusa

| Model | Connection | Driver |
|---|---|---|
| MK4S, MK4, MK3.9, CORE One, MINI+, XL | Ethernet or Wi-Fi, PrusaLink | `prusalink` |
| MK3S+ | USB cable to the Morphix machine (or OctoPrint) | `marlin-serial` (alt: `octoprint`) |

> **Status: not yet hardware-tested.** The PrusaLink driver is implemented from Prusa's published
> PrusaLink API. It has not been run on a real Prusa printer yet.

## Network printers (MK4S, MK4, MK3.9, CORE One, MINI+, XL)

PrusaLink is built into the printer's firmware. Morphix uses it on your local network; Prusa
Connect (the cloud) is not needed.

1. Update the firmware (from **prusa3d.com/drivers**, via USB stick) if it is older than 6.0.
2. Connect the printer: plug in Ethernet, or set up Wi-Fi under **Settings → Network → Wi-Fi**
   (the easiest way is a Wi-Fi config file on the USB stick, see Prusa's help pages).
3. Open **Settings → Network → PrusaLink**. Make sure PrusaLink is **enabled**.
4. The same screen shows the **IP address**, the **user name** (usually `maker`) and the
   **password**. Write them down.

### What to type into Morphix

On **Setup → Printer**, search for your model (for example `mk4s`) and fill in:

- **Printer address**: the IP from step 4.
- **User name**: usually `maker`.
- **Password**: the PrusaLink password from step 4 (stored as a secret).

Press **Test connection**.

## MK3S+ (USB)

The MK3S+ has no network port. Connect it with its USB cable (USB-B) to the Morphix machine.

- **Serial port**: usually `/dev/ttyACM0` (pick the `/dev/serial/by-id/...Prusa...` one if shown).
- **Speed (baud)**: `115200`.

If you already run OctoPrint or PrusaLink on a Raspberry Pi attached to your MK3S+, choose the
OctoPrint connection instead and see the [OctoPrint steps in the generic guide](generic.md).

## Common problems

- **"Auth" error**: the password was changed on the printer (it can be reset from the PrusaLink
  menu). Type the new one into Morphix.
- **Upload is refused**: the printer is printing, or a USB stick is missing on the MINI+ (MINI
  stores uploads on its USB stick). Insert a stick.
- **MK3S+ resets when Morphix connects**: that is normal for USB on this board; wait 5 seconds.
- **Permission denied on the serial port**: add the user to the `dialout` group (see the
  [README](README.md#usb-printers-the-basics)).

## Safety

- Prusa printers check the sheet and run mesh leveling at the start of each print. Keep the
  steel sheet on and clean.
- Morphix limits the nozzle to 290 °C (300 °C on MK3S+) and the bed to 120 °C (100 °C on MINI+).
- With USB, keep the Morphix machine running until the print is finished.
