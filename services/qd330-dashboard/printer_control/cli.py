"""Command line control for the QD330.

usage: python3 -m printer_control.cli <command> [args]
  status | info | files | home | pause | resume | cancel | cooldown | motors-off | dance
  nozzle <C> | bed <C> | fan on|off | led on|off
  print <file-on-printer> | upload <local-file> [--start] | snapshot <out.jpg>
  gcode <CMD> [<CMD> ...]
"""
import json
import os
import sys
from pathlib import Path

from .client import QD330, PrinterError, DEFAULT_HOST


def main(argv=None):
    a = sys.argv[1:] if argv is None else argv
    if not a or a[0] in ("-h", "--help", "help"):
        print(__doc__.strip()); return 0
    p = QD330(os.environ.get("QD330_HOST", DEFAULT_HOST))
    cmd, rest = a[0], a[1:]
    simple = {"home": p.home, "pause": p.pause, "resume": p.resume, "cancel": p.cancel,
              "cooldown": p.cooldown, "motors-off": p.motors_off, "dance": p.dance,
              "status": p.status, "info": p.info, "files": p.files}
    try:
        if cmd in simple and not rest:
            out = simple[cmd]()
        elif cmd in ("nozzle", "bed") and len(rest) == 1:
            out = (p.set_nozzle if cmd == "nozzle" else p.set_bed)(float(rest[0]))
        elif cmd in ("fan", "led") and rest in (["on"], ["off"]):
            out = getattr(p, cmd)(rest[0] == "on")
        elif cmd == "print" and len(rest) == 1:
            out = p.print_file(rest[0])
        elif cmd == "upload" and rest:
            f = Path(rest[0])
            out = p.upload(f.name, f.read_bytes(), start="--start" in rest)
        elif cmd == "snapshot" and len(rest) == 1:
            Path(rest[0]).write_bytes(p.snapshot()); out = f"saved {rest[0]}"
        elif cmd == "gcode" and rest:
            out = p.command(*rest)
        else:
            print(__doc__.strip(), file=sys.stderr); return 2
    except PrinterError as e:
        print(f"error: {e}", file=sys.stderr); return 1
    print(out if isinstance(out, str) else json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
