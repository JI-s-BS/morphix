// Optional HTTPS (MorphixConfig.server.https): a self-signed certificate kept in the data dir.
// Node can't create X.509 certificates by itself, so this runs `openssl` once (no shell).
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface TlsFiles { key: Buffer; cert: Buffer; certPath: string }

export async function selfSignedCert(dataDir: string, opts: { openssl?: string; timeoutMs?: number } = {}): Promise<TlsFiles> {
  const dir = join(dataDir, "tls");
  const keyPath = join(dir, "server.key");
  const certPath = join(dir, "server.crt");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const host = hostname().replace(/[^A-Za-z0-9.-]/g, "") || "morphix";
    const args = [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
      "-keyout", keyPath, "-out", certPath,
      "-subj", `/CN=${host}`,
      "-addext", `subjectAltName=DNS:${host},DNS:${host}.local,DNS:localhost,IP:127.0.0.1`,
    ];
    await new Promise<void>((resolve, reject) => {
      execFile(opts.openssl ?? "openssl", args, { timeout: opts.timeoutMs ?? 60_000 }, (err) => {
        if (err) {
          reject(new Error(
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? "HTTPS is on but `openssl` isn't installed. Install it (sudo apt install openssl) or turn HTTPS off in Settings."
              : `Couldn't create the HTTPS certificate: ${err.message}`,
          ));
        } else resolve();
      });
    });
    chmodSync(keyPath, 0o600);
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), certPath };
}
