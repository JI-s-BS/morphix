import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertStoredFileName,
  crc32,
  encodeCommand,
  encodeFileList,
  findReplyEnd,
  InvalidFileNameError,
  isAcknowledged,
  parseFileList,
  PrinterCommandRejected,
  sanitizeFileName,
} from "@morphix/printer";

describe("phase 5 wire protocol", () => {
  it("frames commands and refuses injected separators", () => {
    expect(encodeCommand("M23 0:/user/a.gx")).toBe("~M23 0:/user/a.gx\r\n");
    expect(() => encodeCommand("M23 a.gx\r\n~G28")).toThrow(PrinterCommandRejected);
    expect(() => encodeCommand("M23 a~b.gx")).toThrow(PrinterCommandRejected);
  });

  it("finds the end of a reply only after its own CMD echo", () => {
    const stale = "ok\r\n";
    const reply = "CMD M119 Received.\r\nMachineStatus: READY\r\nok\r\n";
    expect(findReplyEnd(stale, "M119")).toBe(-1);
    expect(findReplyEnd(stale + reply, "M119")).toBe((stale + reply).length);
    expect(findReplyEnd("CMD M119 Received.\r\nMachineStatus: READY\r\n", "M119")).toBe(-1);
  });

  it("acknowledges only clean Received…ok replies", () => {
    expect(isAcknowledged("CMD M26 Received.\r\nok\r\n", "M26")).toBe(true);
    expect(isAcknowledged("CMD M26 Received.\r\nError: busy\r\nok\r\n", "M26")).toBe(false);
    expect(isAcknowledged("CMD M25 Received.\r\nok\r\n", "M26")).toBe(false);
    // a file name containing "fail" is not an error
    expect(isAcknowledged("CMD M23 Received.\r\nFile opened: fail_test.gx Size: 9\r\nFile selected\r\nok\r\n", "M23", "fail_test.gx")).toBe(true);
  });

  it("crc32 matches zlib", () => {
    const chunk = Buffer.from("G28\nG1 X10\n");
    expect(crc32(chunk)).toBe(zlibCrc32(chunk));
  });

  it("parses the binary M661 list (with and without trailing ok, and incomplete)", () => {
    // hand-built from the recorded format: "D\xaa\xaaD" + BE count, then "::\xa3\xa3" + BE length + name
    const real = Buffer.concat([
      Buffer.from("CMD M661 Received.\r\n"),
      Buffer.from([0x44, 0xaa, 0xaa, 0x44, 0, 0, 0, 1]),
      Buffer.from([0x3a, 0x3a, 0xa3, 0xa3, 0, 0, 0, 13]),
      Buffer.from("/data/dance.g"),
    ]);
    expect(parseFileList(real)).toEqual({ complete: true, paths: ["/data/dance.g"], end: real.length });
    expect(parseFileList(Buffer.concat([real, Buffer.from("\r\nok\r\n")])).paths).toEqual(["/data/dance.g"]);
    expect(parseFileList(real.subarray(0, real.length - 3)).complete).toBe(false);
    expect(parseFileList(Buffer.from("CMD M661 Received.\r\n")).complete).toBe(false);
    const two = encodeFileList(["/data/a.gx", "/data/b c.gx"]);
    expect(parseFileList(two).paths).toEqual(["/data/a.gx", "/data/b c.gx"]);
    expect(parseFileList(encodeFileList([]))).toMatchObject({ complete: true, paths: [] });
  });
});

describe("phase 5 file names", () => {
  it("sanitises upload names to safe .gx names", () => {
    expect(sanitizeFileName("My Dragon (v2).gx")).toBe("My_Dragon_v2.gx");
    expect(sanitizeFileName("../../etc/évil name.GX")).toBe("evil_name.gx");
    expect(sanitizeFileName("C:\\models\\cube.gx")).toBe("cube.gx");
    expect(sanitizeFileName("~M26\r\n.gx".replace("\r\n", ""))).toBe("M26.gx");
    expect(sanitizeFileName("x".repeat(200) + ".gx")).toHaveLength(64);
  });

  it("accepts only .gx unless plain .g is allowed", () => {
    expect(() => sanitizeFileName("dance.g")).toThrow(InvalidFileNameError);
    expect(sanitizeFileName("dance.g", { allowPlainGcode: true })).toBe("dance.g");
    for (const bad of ["model.stl", "model", ".gx", "???.gx", "model.gx.exe"]) expect(() => sanitizeFileName(bad)).toThrow(InvalidFileNameError);
  });

  it("validates stored names without rewriting them", () => {
    expect(assertStoredFileName("Afinia Bunny.gx")).toBe("Afinia Bunny.gx");
    for (const bad of ["a/b.gx", "a\\b.gx", "~a.gx", "a\r\n.gx", ".hidden.gx", " a.gx", "a.g", "a.stl", ""]) {
      expect(() => assertStoredFileName(bad)).toThrow(InvalidFileNameError);
    }
    expect(assertStoredFileName("a.g", { allowPlainGcode: true })).toBe("a.g");
  });
});
