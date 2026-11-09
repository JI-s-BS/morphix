# Sponsor technologies in Morphix

Each one is a working feature, switched on by its key in `~/Morphix/config/morphix.env`
on the Pi; without a key Morphix uses its local fallback. Settings → Grown-ups shows which
keys are set.

| Sponsor | What it does in Morphix | Key | Code |
|---|---|---|---|
| **Auth0** | Sign-in for the Pi's web portal (and the phone app's Connect page). Only allow-listed, verified emails get in; admins may use printer controls. | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_ALLOWED_EMAILS` | `packages/portal`, `apps/desktop/electron/portal-backend.ts`, docs/PORTAL.md |
| **Swarms AI** | Multi-agent second opinion on every confirmed Print Guardian alert (spaghetti, stall, …): pause, keep watching, or false alarm, with a reason shown on the Printer page. | `SWARMS_API_KEY` | `packages/guardian/src/cloud.ts` (`SwarmsReviewClient`), wired in `apps/desktop/electron/printing.ts` |
| **Tiger Data** | Print Guardian history — every watch state change and camera event — streamed into a TimescaleDB hypertable `guardian_telemetry` for charts of print health over time. Buffered locally while offline. | `TIGER_DATABASE_URL` | `apps/desktop/electron/tiger.ts`, `packages/guardian/src/cloud.ts` (`TelemetrySync`) |
| **Vultr** | Serverless Inference runs an open model as the backup "doctor" for self-healing: when Claude can't explain an unknown error, Vultr does (same JSON diagnosis, same safety rules — it can only pick safe remediations). | `VULTR_INFERENCE_API_KEY` (optional `MORPHIX_VULTR_MODEL`) | `packages/healer/src/diagnose.ts` (`createVultrDiagnoser`), `apps/desktop/electron/self-heal.ts` |

## Setup notes

- **Tiger Data:** create a service, copy its connection string (with `sslmode=require`)
  into `TIGER_DATABASE_URL`. Morphix creates the table and hypertable on first use.
  Example query: `SELECT time_bucket('1 hour', at) AS h, type, count(*) FROM guardian_telemetry GROUP BY h, type ORDER BY h;`
- **Vultr:** the inference key is the Serverless Inference subscription's key (Vultr
  dashboard → Serverless Inference), not the account API key. The model is picked from
  `GET /v1/models` unless `MORPHIX_VULTR_MODEL` is set.
- **Swarms:** a Swarms Cloud API key; reviews time out quickly and fall back to local rules.
- Restart Morphix after editing `morphix.env`.
