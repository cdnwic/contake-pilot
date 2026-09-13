# Pilot auth (plan 3ז items #2/#3/#4) — semantics

## #2 Verify-attempt throttling (`apps/api/src/auth.ts`)

- Every wrong presentation of a code **against a live (unexpired) code** increments a
  per-phone attempt counter in the shared `OtpStateStore`. Guesses against an
  expired or non-existent code are not counted (there is nothing to brute-force).
- At **5 attempts** (`OTP_VERIFY_MAX_ATTEMPTS`) the code is **burned** (deleted —
  the correct code then fails too) and verify **locks for 10 minutes**
  (`OTP_LOCKOUT_SEC`). The attempt counter resets at lockout, so the next window
  starts clean.
- The lockout is written as an `otp.verify.lockout` row in the pre-auth audit log
  (`OtpStateStore.appendAuthAudit`; table `auth_audit` in Postgres) with
  `{attempts, maxAttempts, lockedUntil, lockoutSec}`. This is deliberately NOT a
  contracts `AuditLogEntry`: that shape requires orgId/eventId/actorUserId and its
  Action union is pinned (v1.9); a pre-auth OTP event has neither.
- **Anti-enumeration is unchanged**: wrong code, burned code, active lockout,
  expired code and unknown phone all return the identical
  `401 BAD_OTP 'קוד שגוי או פג תוקף'` — the lockout never leaks.
- Request-side rate limiting is unchanged: 5 requests / 10 min / phone → 429.
- A successful verify deletes the code (single-use) and resets the counter.

## #4 Shared OTP store (`OtpStateStore`, PR-1 adapter pattern)

- `OtpStateStore` (auth.ts) abstracts all OTP state: codes, request log, verify
  counters/lockouts, pre-auth audit. Default `memoryOtpState()` for test/dev.
- Postgres adapter: `createPgOtpState(db)` in `apps/api/src/repo/postgres.ts`,
  wired in `server.ts` when `DATABASE_URL` is set (tables: `otp_codes`,
  `otp_requests`, `otp_verify_state`, `auth_audit`). The attempt counter uses an
  atomic `INSERT .. ON CONFLICT .. RETURNING`, so concurrent instances cannot
  overshoot the threshold.

## #3 devCode deploy flag

- `/v1/auth/otp/request` returns the OTP in the response body (`devCode`) unless
  `CONTAKE_DEV_OTP=false` (`apps/api/src/app.ts`, otp/request route). In the pilot
  environment `CONTAKE_DEV_OTP=false` is **mandatory** (deploy config; no code).
