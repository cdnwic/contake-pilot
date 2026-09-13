# Deploy-prep (pilot) — artifacts and env checklist

No deploy yet: the publishing decision goes to Chaim (Sunday). Everything here is prep.

## Platform: Render (pick, over Fly)

`render.yaml` (blueprint) provisions a `starter` web service plus managed Postgres and
wires `DATABASE_URL`. Rationale: the pilot needs zero-ops — managed PG, blueprint-driven
env wiring, and the existing `/v1/health` health check. Fly's strengths (edge placement,
machine-level control) don't matter for a single-region pilot. Migration path to Fly or a
container host stays open: the API is a plain `node apps/api/dist/server.js` with env-only config.

## PG-mode-only env checklist

| Var | Value | Notes |
|---|---|---|
| `DATABASE_URL` | from `contake-pg` | Switches repo, dispatch state AND the OTP store to Postgres (multi-instance ready). |
| `CONTAKE_SEED` | `camp-demo` | Seeds the camp demo dataset only when the DB is empty for the org. |
| `CONTAKE_DEV_OTP` | `false` | **Mandatory in pilot.** Suppresses `devCode` in `/v1/auth/otp/request`. |
| `VAPID_PUBLIC_KEY` | set in Render env config at deploy time | Generated 2026-09-12 with `web-push generate-vapid-keys`. **Never in the tree** (TL ruling: repo keeps empty placeholders only; secret-scan enforces). Pair-consistency verified by deriving the public key from the vaulted private key (P-256). |
| `VAPID_PRIVATE_KEY` | operator vault entry `contake-pilot-vapid` | **Never in the tree, never in messages.** Set in the Render dashboard at publish time. |
| `VAPID_SUBJECT` | `mailto:ops@contake.app` | Contact for the push service (matches canonical `.env.example`). |
| `CORS_ORIGIN` | pilot FE origin (comma-separated list ok) | `@fastify/cors` is registered ONLY when this env is set; unset = no CORS headers (same-origin only). Set at publish time. |
| Twilio / WhatsApp Cloud env | optional | Absent → log-sandbox providers; nothing connects externally without env (QA-M3-4). |

## Web push (G5)

VAPID keypair generated via `npx web-push generate-vapid-keys`. TL ruling: NO key material
in the repo — `.env.example` / `render.yaml` carry empty placeholders only (`sync: false`).
The private key lives only in the operator vault entry `contake-pilot-vapid`
(agent-designated); the matching public key goes into the pilot env's actual config
(Render env vars) at deploy time. Pair-consistency (public derived from the vaulted
private, P-256) is verified before QA's device pass. Deploy acceptance:
`GET /v1/push/vapid-public-key` returns that same public key + a signed test push
round-trips. Rotation: regenerate, re-vault, update env config.
