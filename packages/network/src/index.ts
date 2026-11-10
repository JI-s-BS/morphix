// Wi-Fi management through NetworkManager's nmcli (the app's user must be allowed by polkit).
// Arguments go straight to execFile (no shell). Passwords are never logged.
// The printer's Ethernet link (printer-lan) is shown read-only and never modified.
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import type { NetworkStatus, WifiNetwork } from "@morphix/shared";

export const PRINTER_CONNECTION = "printer-lan";

export type Runner = (args: string[], timeoutMs?: number) => Promise<string>;

export const nmcli: Runner = (args, timeoutMs = 20000) =>
  new Promise((resolve, reject) => {
    execFile("nmcli", args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().replace(/^Error:\s*/, "")));
      else resolve(stdout);
    });
  });

/** Split one line of `nmcli -t` output (":" separated, "\:" escaped). */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) cur += line[++i];
    else if (c === ":") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseWifiList(stdout: string, savedSsids: Set<string>): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [inUse, ssid, signal, security] = splitTerse(line);
    if (!ssid) continue; // hidden networks
    const n: WifiNetwork = { ssid, signal: Number(signal) || 0, security: security || "", inUse: inUse === "*", saved: savedSsids.has(ssid) };
    const prev = best.get(ssid);
    if (!prev || n.inUse || (!prev.inUse && n.signal > prev.signal)) best.set(ssid, n);
  }
  return [...best.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal);
}

export class NetworkManager {
  constructor(private run: Runner = nmcli) {}

  private async savedWifi(): Promise<Map<string, string>> {
    // connection name -> SSID
    const out = await this.run(["-t", "-f", "NAME,TYPE", "connection", "show"]);
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
      const [name, type] = splitTerse(line);
      if (type !== "802-11-wireless") continue;
      const ssid = (await this.run(["-t", "-g", "802-11-wireless.ssid", "connection", "show", name]).catch(() => "")).trim();
      map.set(name, ssid || name);
    }
    return map;
  }

  async status(): Promise<NetworkStatus> {
    const out = await this.run(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"]);
    const status: NetworkStatus = { hostname: hostname(), wifi: null, ethernet: null };
    for (const line of out.split("\n")) {
      const [device, type, state, connection] = splitTerse(line);
      if (type !== "wifi" && type !== "ethernet") continue;
      const ip = (await this.run(["-t", "-g", "IP4.ADDRESS", "device", "show", device]).catch(() => "")).split("\n")[0].split("|")[0].trim() || null;
      if (type === "wifi" && !status.wifi) {
        let signal: number | null = null;
        if (state === "connected") {
          const list = await this.run(["-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list", "--rescan", "no"]).catch(() => "");
          const cur = list.split("\n").map(splitTerse).find((f) => f[0] === "*");
          signal = cur ? Number(cur[1]) : null;
        }
        status.wifi = { device, state, ssid: connection || null, ip, signal };
      }
      if (type === "ethernet" && !status.ethernet) status.ethernet = { device, state, connection: connection || null, ip };
    }
    return status;
  }

  async scan(): Promise<WifiNetwork[]> {
    const saved = new Set((await this.savedWifi()).values());
    const out = await this.run(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"], 30000);
    return parseWifiList(out, saved);
  }

  async connect(ssid: string, password: string | null): Promise<string> {
    if (!ssid || ssid.length > 32) throw new Error("invalid network name");
    if (password !== null && (password.length < 8 || password.length > 63)) throw new Error("Wi-Fi passwords are 8 to 63 characters");
    const saved = await this.savedWifi();
    const existing = [...saved.entries()].find(([, s]) => s === ssid)?.[0];
    if (existing && password === null) {
      await this.run(["connection", "up", existing], 45000);
    } else {
      if (existing) await this.run(["connection", "delete", existing]); // replace stale credentials
      const args = ["device", "wifi", "connect", ssid];
      if (password !== null) args.push("password", password);
      await this.run(args, 45000);
    }
    return `Connected to ${ssid}`;
  }

  async forget(ssid: string): Promise<string> {
    const saved = await this.savedWifi();
    const entry = [...saved.entries()].find(([, s]) => s === ssid);
    if (!entry) throw new Error(`${ssid} is not a saved network`);
    if (entry[0] === PRINTER_CONNECTION) throw new Error("the printer connection cannot be changed here");
    const st = await this.status();
    if (st.wifi?.ssid === entry[0]) throw new Error("connect to another network before forgetting the current one");
    await this.run(["connection", "delete", entry[0]]);
    return `Forgot ${ssid}`;
  }
}
