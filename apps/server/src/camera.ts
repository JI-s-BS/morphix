// Printer camera proxy: the browser only ever sees /api/camera/{stream,snapshot} (same origin,
// behind sign-in); the camera's own address stays on the server.
import { request } from "node:http";
import type { ServerResponse } from "node:http";

const ALLOWED = /^(multipart\/x-mixed-replace|image\/(jpeg|png|webp))/i;

/** Pipes an MJPEG stream or a snapshot to res. Ends with 502 (JSON) when the camera can't be reached. */
export function proxyCamera(url: string | null, res: ServerResponse, timeoutMs = 5000): Promise<void> {
  return new Promise((done) => {
    const fail = (message: string) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: { code: "camera", message, hint: "Check the camera is on and its address is right in Settings." } }));
      } else res.destroy();
      done();
    };
    let u: URL;
    try {
      if (!url) return fail("No camera is set up for this printer.");
      u = new URL(url);
      if (u.protocol !== "http:") return fail("Only http:// cameras are supported.");
    } catch {
      return fail("The camera address isn't valid.");
    }
    const req = request(u, { method: "GET", timeout: timeoutMs }, (up) => {
      const type = String(up.headers["content-type"] ?? "");
      if (up.statusCode !== 200 || !ALLOWED.test(type)) {
        up.resume();
        return fail(`The camera answered ${up.statusCode ?? "?"} ${type ? `(${type.split(";")[0]})` : ""}`.trim());
      }
      req.setTimeout(0); // a stream is long-lived once it started
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      up.pipe(res);
      const end = () => {
        up.destroy();
        done();
      };
      res.on("close", end);
      up.on("end", end);
      up.on("error", end);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => fail(e.message === "timeout" ? "The camera didn't answer in time." : "Can't reach the camera."));
    res.on("close", () => req.destroy());
    req.end();
  });
}
