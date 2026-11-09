"""Web dashboard + JSON API for the QD330, served from the Pi.

Run:  python3 -m printer_control.web
Env:  QD330_HOST (printer IP), QD330_WEB_PORT (default 8000),
      QD330_TOKEN (optional; when set, every request needs ?token= or X-Token)
"""
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .client import QD330, PrinterError, DEFAULT_HOST

HERE = Path(__file__).resolve().parent
printer = QD330(os.environ.get("QD330_HOST", DEFAULT_HOST))
TOKEN = os.environ.get("QD330_TOKEN", "")
MAX_UPLOAD = 200 * 1024 * 1024

_status_cache = {"at": 0.0, "data": None}
_status_lock = threading.Lock()


def cached_status():
    # Several open dashboards poll at once; hit the printer at most every 1.5s.
    with _status_lock:
        if time.time() - _status_cache["at"] > 1.5:
            try:
                _status_cache["data"] = {"online": True, **printer.status()}
            except PrinterError as e:
                _status_cache["data"] = {"online": False, "error": str(e)}
            _status_cache["at"] = time.time()
        return _status_cache["data"]


def _num(body, key, lo, hi):
    v = float(body[key])
    if not lo <= v <= hi:
        raise ValueError(f"{key} must be between {lo} and {hi}")
    return v


ACTIONS = {
    "home": lambda b: printer.home(),
    "pause": lambda b: printer.pause(),
    "resume": lambda b: printer.resume(),
    "cancel": lambda b: printer.cancel(),
    "cooldown": lambda b: printer.cooldown(),
    "motors-off": lambda b: printer.motors_off(),
    "dance": lambda b: printer.dance(),
    "fan": lambda b: printer.fan(bool(b.get("on"))),
    "led": lambda b: printer.led(bool(b.get("on"))),
    "nozzle": lambda b: printer.set_nozzle(_num(b, "temp", 0, 260)),
    "bed": lambda b: printer.set_bed(_num(b, "temp", 0, 110)),
    "print": lambda b: printer.print_file(str(b["file"])),
    "gcode": lambda b: printer.command(*[c.strip() for c in str(b["cmd"]).splitlines() if c.strip()]),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "QD330Control/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---- helpers ----
    def _authed(self, query):
        if not TOKEN:
            return True
        if self.headers.get("X-Token") == TOKEN or query.get("token", [""])[0] == TOKEN:
            return True
        self._json({"error": "token required"}, 401)
        return False

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("file too large")
        return self.rfile.read(n) if n else b""

    # ---- routes ----
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if url.path in ("/", "/index.html"):
            body = (HERE / "static" / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not self._authed(q):
            return
        try:
            if url.path == "/api/status":
                self._json(cached_status())
            elif url.path == "/api/info":
                self._json(printer.info())
            elif url.path == "/api/files":
                self._json({"files": printer.files()})
            elif url.path == "/camera/snapshot":
                img = printer.snapshot()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(img)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(img)
            elif url.path == "/camera/stream":
                self._proxy_stream()
            else:
                self._json({"error": "not found"}, 404)
        except PrinterError as e:
            self._json({"error": str(e)}, 502)
        except OSError as e:
            self._json({"error": f"camera unavailable: {e}"}, 502)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if not self._authed(q):
            return
        try:
            if url.path == "/api/upload":
                name = q.get("name", [""])[0]
                if not name.lower().endswith((".gx", ".g", ".gcode")):
                    raise ValueError("file must be .gx, .g or .gcode")
                start = q.get("start", ["0"])[0] == "1"
                self._json({"ok": True, "reply": printer.upload(name, self._body(), start=start)})
                return
            if url.path.startswith("/api/action/"):
                action = url.path.rsplit("/", 1)[-1]
                if action not in ACTIONS:
                    self._json({"error": f"unknown action {action}"}, 404)
                    return
                raw = self._body()
                body = json.loads(raw) if raw else {}
                reply = ACTIONS[action](body)
                _status_cache["at"] = 0  # force fresh status after any action
                self._json({"ok": True, "reply": reply})
                return
            self._json({"error": "not found"}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            self._json({"error": str(e)}, 400)
        except PrinterError as e:
            self._json({"error": str(e)}, 502)

    def _proxy_stream(self):
        upstream = urllib.request.urlopen(printer.camera_url("stream"), timeout=5)
        self.send_response(200)
        self.send_header("Content-Type", upstream.headers.get("Content-Type"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                chunk = upstream.read(16384)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()


def _restart_on_change():
    """Exit when the code changes (a Pi Manager deploy); systemd restarts us."""
    def snapshot():
        return {p: p.stat().st_mtime for p in HERE.rglob("*") if p.suffix in (".py", ".html")}
    start = snapshot()
    while True:
        time.sleep(3)
        try:
            if snapshot() != start:
                print("code changed, restarting", flush=True)
                os._exit(0)
        except OSError:
            pass


def main():
    port = int(os.environ.get("QD330_WEB_PORT", "8000"))
    threading.Thread(target=_restart_on_change, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    print(f"QD330 control on http://0.0.0.0:{port} -> printer {printer.host}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
