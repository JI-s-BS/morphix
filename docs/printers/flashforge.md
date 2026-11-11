# FlashForge

| Model | Connection | Driver |
|---|---|---|
| Adventurer 5M, Adventurer 5M Pro, AD5X | Wi-Fi / Ethernet, LAN mode (HTTP API, port 8898) | `flashforge-http` |
| Adventurer 3, Adventurer 4 | Wi-Fi / Ethernet (TCP protocol, port 8899) | `flashforge-tcp` |

> **Status: not yet hardware-tested.** These drivers are implemented from FlashForge's protocol
> documents. The `flashforge-tcp` driver is the same one used on the Afinia QD330 (which is
> tested), but it has not been run on a real Adventurer 3 or 4 yet.

## Adventurer 5M, 5M Pro, AD5X

1. On the screen open **Settings → Network** (Wi-Fi icon) and join your network.
2. Turn on **LAN mode only** (or "Local network mode"). The screen then shows a **check code**
   (some firmware calls it the access code). Write it down.
3. Write down the **IP address**.
4. Find the **serial number**: **Settings → About** (starts with `SN`), or the sticker on the back.

**In Morphix**: pick your model and fill in **Printer address**, **Serial number** and **Check
code** (stored as a secret). Press **Test connection**.

## Adventurer 3 and 4

1. Join your network from **Settings → Wi-Fi** (or Ethernet on the Adventurer 4).
2. Write down the **IP address**.

**In Morphix**: pick your model, type the **Printer address**, leave **Port** at `8899`. There is
no code. These printers use FlashForge `.gx` files with (0,0) in the middle of the bed; Morphix
makes these for you.

## Common problems

- **AD5M "auth" error**: LAN mode was turned off and on, which can change the check code. Read it
  again from the screen.
- **"Busy"**: FlashPrint or Orca is connected. The printer accepts one controller at a time.
- **Camera on the 5M**: only the 5M Pro (or a 5M with the add-on camera) has one.

## Safety

- Morphix limits the nozzle to 280 °C (300 °C on the AD5X, 240–265 °C on the Adventurer 3/4) and
  the bed to 110 °C (100 °C on the Adventurer 3/4).
- Keep the door closed on enclosed models while printing.
