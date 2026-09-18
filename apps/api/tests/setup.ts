/** Hermetic test opt-in (security 2026-09-18): dev OTP disclosure is OPT-IN
 *  ONLY, gated on explicit test mode. Vitest sets NODE_ENV=test; this setup
 *  opts the suite into disclosure so the existing OTP-login fixtures keep
 *  working exactly as before. Deployed builds never load this file, and the
 *  production entry point refuses to boot with this flag set. Individual
 *  tests that exercise the gate save/override/restore process.env locally. */
process.env['CONTAKE_DEV_OTP'] = 'true';
