"""Network client for the Afinia QD330 (FlashForge-style protocol on TCP 8899).

Every command is sent as "~<GCODE>\\r\\n" and the printer answers with
"CMD <X> Received." ... "ok". Control is taken with M601 S1 and released
with M602, so each session() grabs control, runs commands and lets go.
"""
import math
import re
import socket
import struct
import threading
import time
import urllib.request
import zlib
from contextlib import contextmanager

DEFAULT_HOST = "192.168.10.51"
CONTROL_PORT = 8899
CAMERA_PORT = 8080
CHUNK = 4096


class PrinterError(Exception):
    pass


class QD330:
    def __init__(self, host=DEFAULT_HOST, port=CONTROL_PORT, timeout=5):
        self.host, self.port, self.timeout = host, port, timeout
        self._lock = threading.Lock()  # the printer handles one control session at a time

    # ---- low level -------------------------------------------------------
    @contextmanager
    def session(self):
        with self._lock:
            try:
                sock = socket.create_connection((self.host, self.port), self.timeout)
            except OSError as e:
                raise PrinterError(f"cannot reach printer at {self.host}:{self.port}: {e}")
            sock.settimeout(1)
            try:
                self._send(sock, "M601 S1")
                yield sock
            finally:
                try:
                    self._send(sock, "M602")
                except OSError:
                    pass
                sock.close()

    def _read(self, sock, wait):
        buf, end = b"", time.time() + wait
        while time.time() < end:
            try:
                data = sock.recv(65536)
                if not data:
                    break
                buf += data
                if buf.rstrip().endswith(b"ok"):
                    break
            except socket.timeout:
                pass
        return buf

    def _send(self, sock, cmd, wait=5):
        sock.sendall(("~" + cmd + "\r\n").encode())
        return self._read(sock, wait)

    def command(self, *cmds, wait=5):
        """Run raw commands; returns {cmd: reply text}."""
        out = {}
        with self.session() as s:
            for c in cmds:
                out[c] = _clean(self._send(s, c, wait=60 if c.upper().startswith("G28") else wait))
        return out

    # ---- status ----------------------------------------------------------
    def info(self):
        return _kv(self.command("M115")["M115"])

    def status(self):
        with self.session() as s:
            raw = {c: _clean(self._send(s, c)) for c in ("M119", "M105", "M114", "M27")}
        st = _kv(raw["M119"])
        temps = {}
        for name, cur, tgt in re.findall(r"(T0|T1|B):\s*([\d.]+)\s*/\s*([\d.]+)", raw["M105"]):
            temps[{"T0": "nozzle", "T1": "nozzle2", "B": "bed"}[name]] = {"current": float(cur), "target": float(tgt)}
        pos = {k.lower(): float(v) for k, v in re.findall(r"([XYZAB]):\s*(-?[\d.]+)", raw["M114"])}
        prog = re.search(r"byte\s+(\d+)\s*/\s*(\d+)", raw["M27"])
        layer = re.search(r"Layer:\s*(\d+)\s*/\s*(\d+)", raw["M27"])
        return {
            "machine": st.get("MachineStatus", "UNKNOWN"),
            "move": st.get("MoveMode", ""),
            "file": st.get("CurrentFile", ""),
            "led": st.get("LED", ""),
            "endstops": st.get("Endstop", ""),
            "temps": temps,
            "position": pos,
            "progress": int(prog.group(1)) * 100 // max(int(prog.group(2)), 1) if prog else 0,
            "layer": [int(layer.group(1)), int(layer.group(2))] if layer else [0, 0],
        }

    def files(self):
        """Names stored on the printer (M661 returns a binary list)."""
        with self.session() as s:
            s.sendall(b"~M661\r\n")
            buf, end = b"", time.time() + 5
            while time.time() < end:
                try:
                    d = s.recv(65536)
                    if not d:
                        break
                    buf += d
                    end = time.time() + 0.5  # stop once the data stops flowing
                except socket.timeout:
                    if buf:
                        break
        names = []
        for part in buf.split(b"::\xa3\xa3")[1:]:
            if len(part) >= 4:
                n = struct.unpack(">I", part[:4])[0]
                name = part[4:4 + n].decode("utf-8", "replace")
                names.append(name.rsplit("/", 1)[-1])
        return names

    # ---- actions ---------------------------------------------------------
    def home(self):
        return self.command("G28")

    def set_nozzle(self, temp):
        return self.command(f"M104 S{int(temp)} T0")

    def set_bed(self, temp):
        return self.command(f"M140 S{int(temp)}")

    def cooldown(self):
        return self.command("M104 S0 T0", "M140 S0")

    def fan(self, on):
        return self.command("M106 S255" if on else "M107")

    def led(self, on):
        return self.command("M146 r255 g255 b255 F0" if on else "M146 r0 g0 b0 F0")

    def motors_off(self):
        return self.command("M18")

    def pause(self):
        return self.command("M25")

    def resume(self):
        return self.command("M24")

    def cancel(self):
        return self.command("M26")

    def print_file(self, name):
        return self.command(f"M23 0:/user/{name}", wait=10)

    def upload(self, name, data, start=False):
        """Store a .gx/.g file on the printer, optionally starting it."""
        name = name.replace("/", "_")
        with self.session() as s:
            r = _clean(self._send(s, f"M28 {len(data)} 0:/user/{name}"))
            if "fail" in r.lower() or "error" in r.lower():
                raise PrinterError(f"upload refused: {r}")
            for i in range(0, len(data), CHUNK):
                chunk = data[i:i + CHUNK]
                s.sendall(struct.pack(">IIII", 0x5A5AA5A5, i // CHUNK, len(chunk), zlib.crc32(chunk))
                          + chunk.ljust(CHUNK, b"\0"))
                self._read(s, 0.05)  # drain any per-packet acknowledgement
            out = {"M28": r, "M29": _clean(self._send(s, "M29", wait=15))}
            if start:
                out["M23"] = _clean(self._send(s, f"M23 0:/user/{name}", wait=10))
        return out

    def dance(self):
        """Upload a motion-only job (no heat, no extrusion, no Z) and run it."""
        return self.upload("dance.g", dance_gcode().encode(), start=True)

    # ---- camera ----------------------------------------------------------
    def camera_url(self, kind="stream"):
        return f"http://{self.host}:{CAMERA_PORT}/?action={kind}"

    def snapshot(self):
        with urllib.request.urlopen(self.camera_url("snapshot"), timeout=5) as r:
            return r.read()


def dance_gcode():
    g = ["G90", "G1 X0 Y0 F4000"]
    g += [f"G1 X{x} Y{y} F5000" for x, y in [(50, 50), (-50, 50), (-50, -50), (50, -50), (50, 50), (0, 0)]]
    g += [f"G1 X{20 if i % 2 == 0 else -20} Y0 F6000" for i in range(6)]
    g += [f"G1 X{40 * math.cos(2 * math.pi * k / 16):.1f} Y{40 * math.sin(2 * math.pi * k / 16):.1f} F5000" for k in range(33)]
    g += [f"G1 X{45 * math.sin(2 * math.pi * k / 32):.1f} Y{25 * math.sin(4 * math.pi * k / 32):.1f} F5000" for k in range(33)]
    g += ["G1 X0 Y0 F4000", "G28"]
    return "\n".join(g) + "\n"


def _clean(raw):
    text = raw.decode("utf-8", "replace").replace("\r", "")
    lines = [l for l in text.split("\n") if l.strip() and not l.startswith("CMD ") and l.strip() != "ok"]
    return "\n".join(lines)


def _kv(text):
    out = {}
    for line in text.split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out
