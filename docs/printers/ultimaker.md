# Ultimaker

| Model | Connection | Driver |
|---|---|---|
| S3, S5, S7 | Ethernet / Wi-Fi (Ultimaker local HTTP API) | `ultimaker` |

> **Status: not yet hardware-tested.** The Ultimaker driver is implemented from Ultimaker's local
> API documentation (`http://<printer>/docs/api/`). It has not been run on a real Ultimaker yet.

Ultimaker printers use **2.85 mm** filament and print `.ufp` files. Morphix makes these for you.

## Put it on the network

1. On the touchscreen open **Preferences → Network** and connect Ethernet or Wi-Fi.
2. Write down the **IP address**.
3. Check `http://<ip>` opens the printer's web page.

## What to type into Morphix

1. Pick your model and type the **Printer address**.
2. Press **Test connection**. The printer's touchscreen asks whether to **allow** Morphix to
   control it. Tap **Allow**.
3. The printer gives Morphix a key. Morphix stores it as a secret, so you only allow it once.

Reading status works without the key; uploading and starting need it.

## Common problems

- **Test times out**: nobody tapped **Allow** on the touchscreen. Try again.
- **"Auth" error later**: the key was removed (**Preferences → Network → Authorized apps** on
  some firmware). Test again and allow it.
- **Print refused**: the loaded material or print core does not match the file. Load the material
  that the slicer used.
- **Digital Factory**: not needed. Morphix only uses the local network.

## Safety

- Morphix limits the nozzle to 280 °C and the build plate to 120 °C (140 °C on the S5).
- The printer checks the build plate is clear only if you confirm it on the screen. Look first.
