// Reference body dimensions for common phones, so cases and holders start from
// published numbers instead of guesses. Body only (height x width x thickness, mm,
// excluding the camera bump); camera, button and port positions are NOT here and are
// always stated as assumptions. Values are the manufacturers' published tech specs,
// copied by hand and not re-measured: the UI must still show "check before printing".
// Devices missing from this table (e.g. iPhone 17) are left to Claude, which must list
// the measurements it assumed.

export interface DeviceDimensions {
  /** Display name, e.g. "iPhone 15 Pro". */
  name: string;
  /** Long side, mm. */
  heightMm: number;
  /** Short side, mm. */
  widthMm: number;
  /** Thickness without the camera bump, mm. */
  depthMm: number;
  /** Where the numbers come from. */
  source: string;
  /** Lower-case phrases that identify the device in a request (longest match wins). */
  aliases: string[];
}

const APPLE = "Apple tech specs (apple.com/iphone/compare)";
const SAMSUNG = "Samsung published specifications (samsung.com)";
const GOOGLE = "Google published tech specs (store.google.com)";

function d(name: string, heightMm: number, widthMm: number, depthMm: number, source: string, extra: string[] = []): DeviceDimensions {
  return { name, heightMm, widthMm, depthMm, source, aliases: [name.toLowerCase(), ...extra] };
}

export const DEVICES: readonly DeviceDimensions[] = [
  d("iPhone 13", 146.7, 71.5, 7.65, APPLE),
  d("iPhone 13 mini", 131.5, 64.2, 7.65, APPLE),
  d("iPhone 13 Pro", 146.7, 71.5, 7.65, APPLE),
  d("iPhone 13 Pro Max", 160.8, 78.1, 7.65, APPLE),
  d("iPhone 14", 146.7, 71.5, 7.8, APPLE),
  d("iPhone 14 Plus", 160.8, 78.1, 7.8, APPLE),
  d("iPhone 14 Pro", 147.5, 71.5, 7.85, APPLE),
  d("iPhone 14 Pro Max", 160.7, 77.6, 7.85, APPLE),
  d("iPhone 15", 147.6, 71.6, 7.8, APPLE),
  d("iPhone 15 Plus", 160.9, 77.8, 7.8, APPLE),
  d("iPhone 15 Pro", 146.6, 70.6, 8.25, APPLE),
  d("iPhone 15 Pro Max", 159.9, 76.7, 8.25, APPLE),
  d("iPhone 16", 147.6, 71.6, 7.8, APPLE),
  d("iPhone 16 Plus", 160.9, 77.8, 7.8, APPLE),
  d("iPhone 16 Pro", 149.6, 71.5, 8.25, APPLE),
  d("iPhone 16 Pro Max", 163.0, 77.6, 8.25, APPLE),
  d("iPhone 16e", 146.7, 71.5, 7.8, APPLE),
  d("iPhone SE (3rd generation)", 138.4, 67.3, 7.3, APPLE, ["iphone se 3", "iphone se (2022)", "iphone se 2022", "iphone se"]),
  d("Galaxy S24", 147.0, 70.6, 7.6, SAMSUNG, ["samsung galaxy s24", "samsung s24"]),
  d("Galaxy S24+", 158.5, 75.9, 7.7, SAMSUNG, ["galaxy s24 plus", "samsung s24+", "samsung s24 plus"]),
  d("Galaxy S24 Ultra", 162.3, 79.0, 8.6, SAMSUNG, ["samsung galaxy s24 ultra", "samsung s24 ultra", "s24 ultra"]),
  d("Galaxy S25", 146.9, 70.5, 7.2, SAMSUNG, ["samsung galaxy s25", "samsung s25"]),
  d("Galaxy S25 Ultra", 162.8, 77.6, 8.2, SAMSUNG, ["samsung galaxy s25 ultra", "samsung s25 ultra", "s25 ultra"]),
  d("Pixel 8", 150.5, 70.8, 8.9, GOOGLE, ["google pixel 8"]),
  d("Pixel 8 Pro", 162.6, 76.5, 8.8, GOOGLE, ["google pixel 8 pro"]),
  d("Pixel 9", 152.8, 72.0, 8.5, GOOGLE, ["google pixel 9"]),
  d("Pixel 9 Pro", 152.8, 72.0, 8.5, GOOGLE, ["google pixel 9 pro"]),
  d("Pixel 9 Pro XL", 162.8, 76.6, 8.5, GOOGLE, ["google pixel 9 pro xl"]),
];

/** Lower-case, single spaces, "+" kept, other punctuation dropped. */
function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9+()]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * The table device named in a request, or null. The longest alias wins, and an alias
 * only matches as whole words, so "iPhone 15 Pro Max" never resolves to "iPhone 15"
 * and "iPhone 17" does not match anything.
 */
export function lookupDevice(description: string, devices: readonly DeviceDimensions[] = DEVICES): DeviceDimensions | null {
  const text = norm(description);
  let best: { dev: DeviceDimensions; len: number } | null = null;
  for (const dev of devices) {
    for (const alias of dev.aliases) {
      const a = norm(alias);
      // "+" is not a word character, so "galaxy s24+" must not also match "galaxy s24 ".
      if (text.includes(a) && (!best || a.length > best.len)) best = { dev, len: a.length };
    }
  }
  return best?.dev ?? null;
}

const DEVICE_WORDS = /\b(i?phone|iphone\s*\w+|galaxy|pixel|ipad|tablet|airpods?|smartphone|android|kindle|switch|steam deck|apple watch|watch)\b/i;
const FIT_WORDS = /\b(case|cover|bumper|sleeve|holder|mount|dock|stand|cradle|clip|adapter|insert|replacement|fits?|fitting|snap)\b/i;

/** True when the request is about a specific device the part must fit. */
export function mentionsDevice(description: string): boolean {
  return DEVICE_WORDS.test(description);
}

/** True when the part has to fit something (case, mount, replacement part...). */
export function isFitCritical(description: string): boolean {
  return FIT_WORDS.test(description) || mentionsDevice(description);
}

export function describeDevice(dev: DeviceDimensions): string {
  return `${dev.name} body ${dev.heightMm} x ${dev.widthMm} x ${dev.depthMm} mm (height x width x thickness, without camera bump) from ${dev.source}`;
}
