# Camp demo seed (plan 3ח)

A rich, self-contained camp-day dataset for demos and pilot dry-runs.
Fixture module: `apps/api/src/demo/camp-demo.ts`. Loader: `apps/api/src/demo/load-camp-demo.ts`.

## What's in it

- Org `org-camp-demo`, one **published** event `cd-ev1` ("יום קייטנה מלא — קייטנת אורנים", 2026-09-14, Asia/Jerusalem).
- Staff: admin (דנה אוחיון), 2 field managers (רונית לוי, אבי שרון), 6 counselors (focus workers with phones, OTP-loginable).
- 36 parent channels (12 per group), groups: כיתה דבורה / כיתה נמלה / כיתה צב.
- Resources: 3 buses (routes צפון/מרכז/דרום), 6 counselors, בריכה, מטבח וחדר אוכל, מגרש ספורט, חצר משחקים, אולם.
- Full-day schedule (18 tasks, 19 hard dependencies): morning pickup buses (07:00/07:00/07:15) → מפגש בוקר ודגל (08:00) → ארוחת בוקר (08:15) → rotation round 1 (בריכה/ספורט/יצירה, 09:00) → rotation round 2 (10:15) → **ארוחת צהריים חמה (12:00, locked)** → מנוחה (13:00) → משחקי שדה (13:45) → חטיף והתארגנות (14:45) → buses back (15:30/15:30/15:45).

## Loading

- **Server boot (local dev/demo only, either adapter):** `CONTAKE_SEED=camp-demo pnpm --filter @contake/api dev` — memory mode seeds on start; PG mode seeds when the database is empty for the demo org. Fail-closed hotfix (2026-09-17): seeds are applied ONLY on an explicit recognized CONTAKE_SEED (`demo`|`camp-demo`|`all-demo`), CONTAKE_SEED is FORBIDDEN in production (NODE_ENV=production refuses to boot with it set, and the Render blueprint no longer carries it), and OTP devCode requires exactly CONTAKE_DEV_OTP=true outside production.
- **Standalone script:**
  - memory: `pnpm --filter @contake/api exec tsx src/demo/load-camp-demo.ts --impl memory`
  - Postgres: `DATABASE_URL=... tsx src/demo/load-camp-demo.ts --impl postgres`, or local PGlite: `PGDATA=/tmp/cdpg tsx src/demo/load-camp-demo.ts --impl postgres`
  - Idempotent: skips when `cd-ev1` already exists.
- Logins: admin `dana@oranim-camp.local` / `camp-admin-1`; counselors log in by phone OTP (devCode is returned while `CONTAKE_DEV_OTP` is not `false`).

## The late-bus scenario (אוטובוס 3 מתאחר)

The graph is built for this demo. יובל אדרי (counselor on bus 3, phone `+972500100013`) reports from the field:

```
POST /v1/reports
{ "eventId": "cd-ev1", "taskId": "cd-t-bus3", "status": "delayed", "delayMin": 20,
  "noteHe": "אוטובוס 3 מתאחר — פקק בצומת דרום", "clientReportId": "demo-1" }
```

Domino result (asserted in `tests/camp-demo.test.ts`, both adapters): bus 3 moves 07:15→07:35 and 5 dependent tasks follow — מפגש בוקר ודגל (08:00→08:20), ארוחת בוקר (08:15→08:35) and all three rotation-1 activities (09:00→09:05). Slack then absorbs the delay: rotation 2, the locked lunch (12:00) and the whole afternoon/buses-back program stay put. Impact S3 — parents of all three groups get the Hebrew delay notification.
