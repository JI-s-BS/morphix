// Local demo: FakeBackend + a fake Auth0 on this computer. No keys, no printer, no Pi.
// Run from the repo root: node packages/portal/demo.mjs [port]   (then open the printed URL)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal } from "./server";
import { FakeBackend } from "./fake-backend";
import { FakeOidcServer } from "./fake-oidc";

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? process.env.PORTAL_DEMO_PORT ?? 8443);
  const email = process.env.PORTAL_DEMO_EMAIL ?? "grown-up@example.com";
  const storageRoot = mkdtempSync(join(tmpdir(), "morphix-portal-demo-"));
  const oidc = new FakeOidcServer({ clientId: "demo-client", clientSecret: "demo-secret", email });
  const issuer = await oidc.start();
  const backend = new FakeBackend({ storageRoot, tickMs: 1500, printControlsEnabled: true, cameraFrameMs: 1000 });
  const portal = createPortal({
    backend,
    storageRoot,
    host: "127.0.0.1",
    port,
    log: (l) => console.log(l),
    auth: {
      ok: true,
      config: {
        domain: "fake.auth0.local",
        issuerBaseUrl: issuer,
        clientId: "demo-client",
        clientSecret: "demo-secret",
        baseUrl: `http://127.0.0.1:${port}`,
        sessionSecret: "demo-session-secret-demo-session-secret",
        allowedEmails: [email],
        adminEmails: process.env.PORTAL_DEMO_ADMIN === "0" ? [] : [email],
      },
    },
  });
  const { url } = await portal.start();
  console.log(`\nMorphix portal demo: ${url}  (signs in as ${email}; describe something with "fail" to see an error card)\n`);
  const shutdown = async () => {
    backend.close();
    await portal.stop();
    await oidc.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
