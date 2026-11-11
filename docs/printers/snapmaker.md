# Snapmaker

| Model | Connection | Driver |
|---|---|---|
| J1 / J1s (IDEX), Artisan, 2.0 A350T / F350, 2.0 A250T / F250 | Wi-Fi (Snapmaker HTTP API, port 8080) | `snapmaker` |

> **Status: not yet hardware-tested.** The Snapmaker driver is implemented from the Snapmaker
> HTTP API used by Luban. It has not been run on a real Snapmaker yet.

Morphix supports the **3D printing** module only. It does not run the laser or CNC modules.

## Put it on the network

1. On the touchscreen open **Settings → Wi-Fi** and join your network.
2. Write down the **IP address** (shown in **Settings → Wi-Fi** or **About**).
3. Make sure the 3D printing head is attached.

## What to type into Morphix

1. Pick your model and type the **Printer address**.
2. Press **Test connection**. The printer's touchscreen now asks whether to **accept the
   connection**. Tap **Yes / Accept** within about 30 seconds.
3. The printer gives Morphix a token. Morphix stores it as a secret, so you only confirm once.

## Common problems

- **Test times out**: nobody tapped **Accept** on the touchscreen. Press test again and tap it.
- **"Auth" error later**: the printer forgot the token (after a firmware update or reset). Press
  **Test connection** again and accept on the screen.
- **J1 prints with the wrong head**: Morphix sends single-head prints; use the left (T0) head.
- **Laser or CNC module attached**: Morphix refuses to start; switch to the 3D printing module.

## Safety

- Morphix limits the nozzle to 275 °C (300 °C on J1 and Artisan) and the bed to 100 °C (110 °C on
  the Artisan).
- Close the enclosure door if you have one.
