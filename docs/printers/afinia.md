# Afinia

| Model | Connection | Driver |
|---|---|---|
| QD330 | Wi-Fi or Ethernet (FlashForge TCP protocol, port 8899) | `flashforge-tcp` |

> **Status: tested.** The QD330 is the printer Morphix was built on. It has been run end to end
> on real hardware: connect, upload, start, pause, status. It is the only printer in the catalog
> tested this way.

The QD330 is built on FlashForge hardware and speaks FlashForge's TCP protocol. Its (0,0) is the
middle of the bed, and it prints FlashForge `.gx` files. Morphix makes these for you.

## Put it on the network

1. On the printer's touchscreen, open **Settings → Wi-Fi** (or plug in an Ethernet cable).
2. Join your network. The screen then shows the printer's **IP address**. Write it down.
3. Give the printer a fixed IP in your router so it does not change.

There is no password or access code on the QD330's network port.

## What to type into Morphix

On **Setup → Printer**, pick **Afinia QD330**, then:

- **Printer address**: the IP from the screen, for example `192.168.1.50`.
- **Port**: leave the default, `8899`.

Press **Test connection**. You should see the printer's name and firmware version.

## Common problems

- **"Unreachable"**: the IP changed, or the printer is asleep. Wake the screen, check the IP, and
  check that the Morphix machine is on the same network (not a guest Wi-Fi).
- **"Busy"**: the printer is printing or another program (FlashPrint, Polar Cloud) is connected.
  Close the other program. The printer accepts one controller at a time.
- **Print starts in the wrong place**: make sure you picked the QD330 model, not a Generic one.
  The QD330 uses a center origin.

## Safety

- Keep the door closed while printing; the enclosure keeps heat in and fingers out.
- Morphix limits the nozzle to 250 °C and the bed to 100 °C on this printer.
- Morphix only starts a print when you press start.
