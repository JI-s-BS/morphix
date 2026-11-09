import { describe, expect, it } from "vitest";
import { assertReadOnly, cleanReply, parseInfo, parseStatus, PrinterCommandRejected, TcpTransport } from "@morphix/printer";

describe("printer observation mode", () => {
  it("allows only read-only commands", () => {
    for (const ok of ["M115", "M119", "M105", "M114", "M27"]) expect(() => assertReadOnly(ok)).not.toThrow();
    for (const bad of ["G28", "G1 X0", "M104 S200", "M140 S60", "M23 0:/user/x.gx", "M24", "M25", "M26", "M28 10 0:/user/x", "M18"]) {
      expect(() => assertReadOnly(bad)).toThrow(PrinterCommandRejected);
    }
  });

  it("refuses control commands before opening a socket", async () => {
    await expect(new TcpTransport("192.0.2.1").query(["G28"])).rejects.toThrow(PrinterCommandRejected);
  });

  it("parses real QD330 replies", () => {
    const r = {
      M119: cleanReply("CMD M119 Received.\r\nEndstop: X-max: 110 Y-max: 110 Z-min: 0\r\nMachineStatus: READY\r\nMoveMode: READY\r\nStatus: S:1 L:0 J:0 F:0\r\nLED: 1\r\nCurrentFile: \r\nok\r\n"),
      M105: cleanReply("CMD M105 Received.\r\nT0:26.9/0.0 T1:0.0/0.0 B:24.4/0.0\r\nok\r\n"),
      M114: cleanReply("CMD M114 Received.\r\nX:110.037 Y:110.037 Z:220.000 A:0.000 B:0\r\nok\r\n"),
      M27: cleanReply("CMD M27 Received.\r\nSD printing byte 42/100\r\nLayer: 3/120\r\nok\r\n"),
    };
    const s = parseStatus(r);
    expect(s.machine).toBe("READY");
    expect(s.temps?.nozzle).toEqual({ current: 26.9, target: 0 });
    expect(s.temps?.bed).toEqual({ current: 24.4, target: 0 });
    expect(s.position).toEqual({ x: 110.037, y: 110.037, z: 220 });
    expect(s.progress).toBe(42);
    expect(s.layer).toEqual([3, 120]);
    const info = parseInfo(cleanReply("CMD M115 Received.\r\nMachine Type: Afinia 3D QD330\r\nMachine Name: QD330\r\nFirmware: v2.1.3\r\nSN: SNMRHD9100129\r\nX: 220 Y: 220 Z: 220\r\nok\r\n"));
    expect(info.machineType).toBe("Afinia 3D QD330");
    expect(info.firmware).toBe("v2.1.3");
  });
});
