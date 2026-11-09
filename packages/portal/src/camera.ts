// Helper for the integrator: open the printer's MJPEG stream (mjpg-streamer) as a CameraStream.
// The camera URL is only ever used server-side; the browser sees /api/camera behind login.
import { request } from "node:http";
import type { CameraStream } from "./types";

export function httpCameraSource(url: string, timeoutMs = 5000): Promise<CameraStream | null> {
  return new Promise((resolve) => {
    const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
      const type = String(res.headers["content-type"] ?? "");
      if (res.statusCode !== 200 || !/^multipart\/x-mixed-replace|^image\/jpeg/i.test(type)) {
        res.destroy();
        return resolve(null);
      }
      req.setTimeout(0); // the stream is long-lived once it started
      resolve({ contentType: type, stream: res });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}
