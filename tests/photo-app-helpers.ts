// Fakes for the phone "Photo to 3D" tests. Nothing here touches the network or spends credits.
import { GeminiImageClient, type FetchLike } from "@morphix/photo3d";
import { analysisAnswer, JPEG, PNG } from "./photo3d-helpers";

export { JPEG, PNG };

/** A JPEG with an EXIF (APP1) segment carrying fake GPS text, a comment, then the image data. */
export function jpegWithExif(): Uint8Array {
  const exif = Buffer.from("Exif\0\0GPS 42.3601 N 71.0589 W");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 7]), Buffer.from("hello")]);
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sos = Buffer.from([0xff, 0xda, 0, 2, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, com, sos]));
}

export const CLEAN_PNG = Uint8Array.from([...PNG, 1, 2, 3, 4, 5, 6, 7, 8]);

/** Gemini image-model double: answers with CLEAN_PNG (or a scripted reply) and records calls. */
export function fakeImageGemini(reply?: (call: any) => { status?: number; body: string }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const r = reply?.(call) ?? { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/png", data: Buffer.from(CLEAN_PNG).toString("base64") } }] }, finishReason: "STOP" }] }) };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.body };
  };
  return { client: new GeminiImageClient({ apiKey: "img-key", fetch, model: "gemini-image-test" }), calls };
}

/** A decorative "keychain of my friend" analysis with a busy background. */
export function figureAnswer(over: Record<string, unknown> = {}) {
  return analysisAnswer({
    objectName: "keychain figure of a person",
    objectDescription: "A small standing figure of the person in the photo",
    category: "decorative",
    mechanical: false,
    recommendedEngine: "meshy-image",
    engineReason: "An organic shape (a person) is best made by image-to-3D.",
    dimensions: {
      width: { valueMm: 30, confidence: 0.5, method: "typical-size" },
      depth: { valueMm: 15, confidence: 0.5, method: "typical-size" },
      height: { valueMm: 60, confidence: 0.5, method: "typical-size" },
    },
    openscadSpec: { applicable: false },
    photo: { subject: "the person in the blue jacket", needsCleanup: true, cleanupReason: "Busy street behind the person", bestPhotoIndex: 0, sameObjectAllPhotos: false },
    ...over,
  });
}

/** A functional "replacement clip" analysis (CAD). */
export function clipAnswer(over: Record<string, unknown> = {}) {
  return analysisAnswer({
    objectName: "replacement belt clip",
    photo: { subject: "the broken clip", needsCleanup: true, cleanupReason: "Clutter on the desk", bestPhotoIndex: 0, sameObjectAllPhotos: true },
    ...over,
  });
}
