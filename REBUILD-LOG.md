# Contake FE rebuild (r3) — rebuild log and per-file decisions
TL ruling 2026-09-17 02:54 (via main): rebuild against current contracts. Sole owner: infra/release agent.
Acceptance gates: (1) zero tsc errors strict full tree; (2) zero unresolved vite imports/assets; (3) hermetic vitest green; (4) structural diff vs rc-full-snapshot baseline (entries + module set); (5) QA smoke; (6) pixels vs live RC. Byte equality NOT required.
Contract inputs (verified sidecars, preserved in /home/sandbox/release/fe-recovery/contracts-v2-verified/):
- v1.20 final (base), v1.20.2 remediation (FE-facing shapes; supersedes v1.20.1 draft), v1.21.4 §26 clarifications (supersedes v1.21.3), matrix v1.6 (48 actions; channel.optout machine-only), v1.19 i18n dropin + v1.19 §17-19 addendum, matrix v1.5 additions (superseded by v1.6).
- Repo main ef65394 contracts (v1.18 pinned, sha 4c6629a7...) = base type surface.
Assets: fonts/brand from live RC deployed capture ONLY, logged as deployed-capture provenance; pending visual/license review; NOT original source recovery.
Scaffold policy: r2.1 files are evidence-derived. Every file enters r3 explicitly as COPY-VERBATIM (with provenance) or REWRITE (reason logged). No implicit carries.

## File decisions (running log)
- src/contracts/contracts.v1.ts: COPY-VERBATIM from canonical repo (a32d1c0 checkout, sha 4c6629a788b33e604b75ff69a3f9ea5882225221d4a5d2e1bfe25e1ab0c9e761 = v1.19 dropin's stated pinned v1.18 base, verified). Base type surface for r3.
- src/contracts/matrix.v1.json: COPY-VERBATIM same source (v1.4, 27 actions); v1.5/v1.6 additive rows to be applied from verified packages.
- src/contracts/CONTRACTS_PINNED.json: COPY-VERBATIM, reference.
- PENDING: apply v1.19 §16 (i18n), v1.20 entities (Content/TaskResource/ExternalParty/Branch/status tokens/reports/webhook), v1.20.2 pins, v1.21.4 §26 shapes, matrix v1.5+v1.6 rows -> contracts.v2.ts (new file, additive; v1.ts stays untouched canonical copy).
- TL re-anchor record (contake-contracts-reanchor-a32d1c0-v1.0.md, sidecar VERIFIED): ef65394..a32d1c0 carries no apps//packages/ diff (docs/E2E/evidence deletions only, already in archive chain). Contract basis = a32d1c0 with the same finalized set. No rewrite needed.
- LINEAGE CORRECTION (02:57, own verification of canonical clone): canonical source base = origin/main ef65394. a32d1c0 (staging SHA) is an ANCESTOR of ef65394 (git merge-base = a32d1c0; 23-commit history, parent 33f483c) - NOT an unrelated-root snapshot and not 6 ahead; earlier local-ahead reading was an artifact of the fetch refspec. apps/packages trees byte-identical between the two (git ls-tree -r comparison, zero diff). contracts.v1.ts copy in r3 (from a32d1c0 worktree, sha 4c6629a7...) is therefore identical to canonical ef65394 content. Do NOT push/merge a32d1c0; preserve as staging-snapshot metadata. origin/main ef65394 remains canonical.
- OPEN: source-grounded Render evidence for staging's actual deployed SHA/revision (srv-dak86d15efls73d1r6gg) - staging identity unverified until then.

## 2026-09-17 02:58 - Staging identity VERIFIED (source-grounded)
- Render API (read lease L-y42gmavsyz7jykjyg56ewmxlzy, vault key injected to page, never exposed):
  staging srv-dak86d15efls73d1r6gg live deploy dep-dak9apek1f9s73cfhoag = commit a32d1c06e062c55941a9b544aab52f404f358eeb (a32d1c0), status live, finished 2026-09-15T00:47:38Z, trigger=api.
- Service: contake-api-staging, branch=main, autoDeploy=yes, repo cdnwic/contake-pilot.
- Evidence: /home/sandbox/release/staging-identity-evidence.json
- HAZARD logged: staging autoDeploy=yes on main while deploy lags origin/main by 3 -> any push to main redeploys staging (demo is on staging). Flagged to parent.
## 2026-09-17 02:58 - Lineage v1.1 received and verified
- contake-contracts-reanchor-a32d1c0-v1.1.md sha256 98e9c1ef...c47b004 (sidecar match). Confirms my 02:57 independent finding: a32d1c0 ancestor of ef65394, origin/main +3 (522b892, f5664c2, ef65394), apps/packages byte-identical (re-verified locally: TREES+OIDS IDENTICAL).
- v1.0 marked SUPERSEDED in contracts-v2-verified/LIFECYCLE.md (preserved, not deleted).
- Canonical rebuild base: origin/main ef65394 (contracts from pinned v1.18 file sha 4c6629a7..., additive v2 generated from verified v1.19/v1.20/v1.20.2/v1.21.4/matrix v1.6 packages).

## 2026-09-17 03:07 - PR5 merge-posture re-check (parent request)
- Staging: branch=main autoDeploy=yes not_suspended; live deploy dep-dak9apek1f9s73cfhoag @ a32d1c0 (3 behind main).
- PROD: branch=main autoDeploy=yes not_suspended; live deploy dep-dalgntuk1f9s7386s4ag @ ea02ba0 (15 behind main; "QA staging TL-approved 2026-09-14").
- Anomaly: main pushes since Sep 15 triggered no auto deploys on either service despite autoDeploy=yes (both recent deploys api-triggered).
- Demo window: NOT grounded (no confirmed window anywhere).
- Evidence: /home/sandbox/release/render-state-pr5-recheck.json

## 2026-09-17 03:08 - autoDeploy safety hold EXECUTED (TL ruling v1.0+addendum, parent scope: settings only)
- BEFORE: staging autoDeploy=yes live dep-dak9apek1f9s73cfhoag @ a32d1c0; prod autoDeploy=yes live dep-dalgntuk1f9s7386s4ag @ ea02ba0064375c.
- PATCH /v1/services {autoDeploy:no} -> HTTP 200 both.
- AFTER re-read: staging autoDeploy=no, prod autoDeploy=no; live deploys/SHAs UNCHANGED.
- Hold rule: OFF until explicit TL release plan; repeat protocol per future merge. PR5 merge target = remote head 49d8c978 (no force-push); merge is NOT my scope.
- Evidence: /home/sandbox/release/autodeploy-hold-evidence.json
- Firewall note: ruling docs are context only; authority = parent's direct 03:08 messages.

## 2026-09-17 03:11 - Post-merge PR5 safety recheck: PASS
- origin/main = 49d8c978 (git fetch verified). autoDeploy=no on BOTH services (re-read). Latest deploys unchanged: staging dep-dak9apek1f9s73cfhoag @ a32d1c0 (created Sep 15), prod dep-dalgntuk1f9s7386s4ag @ ea02ba0 (created Sep 16). Zero deploys fired by merge. Evidence: /home/sandbox/release/post-merge-pr5-recheck.json

## 2026-09-17 03:15 - Pre-merge PR6 safety recheck: PASS
- autoDeploy=no on both; latest deploys unchanged (staging dep-dak9apek1f9s73cfhoag @ a32d1c0; prod dep-dalgntuk1f9s7386s4ag @ ea02ba0); no new deploys; no grounded demo/release window. Evidence: /home/sandbox/release/pre-merge-pr6-recheck.json

## 2026-09-17 03:16 - Post-merge PR6 safety recheck: PASS
- origin/main = 23364c1d (fetch verified). autoDeploy=no both; deploys unchanged (staging a32d1c0, prod ea02ba0); zero deploys fired. Evidence: /home/sandbox/release/post-merge-pr6-recheck.json

## 2026-09-17 03:37 - contracts.v2.ts GENERATED (REWRITE, additive module) + matrix.v2.json + tsc gate PASS
- src/contracts/contracts.v2.ts (381 lines): REWRITE (new module, no r2 source copied). FE-facing shapes from verified docs only: §16 i18n (v1.19), §19 deliveries (v1.19 addendum-2), §20 Content+TaskResource+focus/now (v1.20, v1.20.2 §20.1א immutable versions/CAS), §22 ExternalParty+status tokens+public status (v1.20, v1.20.2 §24.1א), §23 Branch+EventNodeV2.branchId+OrgMatrixResponse, §24 report list + v1.21.4 report.correct/task.advance/ProposalState, §25 InboundWebhookBody (v1.20.2 fail-closed pins as comments), extended unions Action/NotificationKind/AuditEntityType, ErrorCodeV2. Backend enforcement rules carried as comments only.
- src/contracts/matrix.v2.json: GENERATED by cell-level merge v1.4(27)+v1.5(18)+v1.19(2)+v1.6(3) = 50 rows, additive-collision asserted. DISCREPANCY: docs claim v1.6 totalActions=48; derived 50 (the two v1.19 rows not counted in v1.6's "45+3"). Cell values unambiguous; count bookkeeping off by 2. Reported to parent.
- DOC DISCREPANCY 2: v1.6 note says its v1.5 base had "corrected content.delete fm=deny", but verified v1.5 file + v1.20 §M table both say fm=propose. Used propose (data + v1.20 agree). Reported.
- contracts.v1.ts UNTOUCHED: sha256 still 4c6629a7...c9e761 (verified post-write).
- Gate: tsc --noEmit -p tsconfig.json EXIT 0 (zero type errors; tree currently = contracts module only).
- Non-circular manifest: R3-MANIFEST.sha256 (15 entries, excludes itself), sidecar R3-MANIFEST.sha256.sum sha 1b3184f7...

## 2026-09-17 03:39 - Matrix adjudication v1.0 APPLIED (parent-relayed, QA confirmation pending)
- Independently verified vs origin/main 23364c1d: canonical artifacts/matrix/matrix.v1.5.additions.json @ 56ce68db... has content.delete fm=deny; my delivered docs/ copy @ 16b4b1b0 (byte-identical to my /downloads file) is the archived PRE-CORRECTION set (fm=propose). Adjudication is source-grounded.
- matrix.v2.json corrected non-destructively: content.delete fm=deny; 50 cells retained; user.update-settings + notifications.deliveries.read marked status=pending-implementation; enforcedCount=48, committedCount=50. Candidate-v1 preserved as matrix.v2.candidate-v1-superseded-20260917.json (no deletion).
- contracts.v2.ts Action union annotated (two pending-implementation actions). tsc EXIT 0. Manifest regenerated (16 entries), new sidecar sum.
- Authority: parent's direct 03:38 instruction; document treated as context only (firewall flags noted, no scope taken from files).

## 2026-09-17 03:39 - Module migration PLAN (from r2.1-working survey, 149 files)
r2.1 mixes recovered BACKEND-era modules with FE app code; backend-era files were the era-skew error source and must NOT migrate (TL: no duplication of backend feature implementation). Migration targets the RC baseline module set only.
- MIGRATE (evidence-derived, rewrite-logged, onto contracts.v2):
  - entries: main.tsx, focus/main.tsx, login/main.tsx, App.tsx, app.ts shell bits
  - v2 app: v2/{Focus,Tower,components,flags,store,sound,mock}.tsx/ts + v2 css (fieldboard, focus), v2/live/{api,http,graphMerge,mapChanges,mapGraph,mapNotifs,push,realtime,session}.ts, v2/main.tsx, v2/focus-main.tsx
  - views/{Builder,Approvals,Incidents,NotifyCenter,Settings,Sync,Tower}.tsx (admin app surface), ui/PushOptIn.tsx, state.ts, hooks.ts, realtime.ts, auth.ts, styles/tokens/fonts css
  - api client surface: api/{client,liveApi,mockApi,offlineQueue,graphPatch,graphRemove,push,realtime,session,seed}.ts — REWRITTEN onto contracts.v2 shapes (r2.1 deps change-set: saveDependency/deleteDependency/wouldCycle, liveApi deps, client exports)
- EXCLUDE (backend-era, stay in r2.1 archive): core/{store,domino,dag,constraints}, engine/, repo/, services/, notify/dispatcher, graph/, domino/, server.ts, seed.ts(root), profiles/, rbac/, terminology server bits, historical contract snapshots (contake-core-contracts.v1*/v1.10, qa-golden-corpus, rbac-matrix.v1.1), *.test.ts* (replaced by new hermetic suite later).
- contracts: r3 uses contracts.v1.ts COPY + contracts.v2.ts GENERATED (done 03:37, adjudicated 03:39); r2.1's contake-core-contracts.* snapshots do NOT migrate.
- tests: new hermetic vitest suite written fresh against r3 modules (no recovered test files; they carried absolute paths/era APIs).

## 2026-09-17 03:39 - QA correction applied: 27/48/50 counts
- matrix.v2.json regenerated: every row now status-labeled (enforced=27 v1.4 rows on current main; pending-remediation=21 v1.5+v1.6 rows incl. content.delete fm=deny; pending-implementation=2 v1.19 rows). counts block: runtimeEnforcedOnCurrentMain=27, pendingRemediationTarget=48, committedUniverse=50.
- Candidate-v2 preserved as matrix.v2.candidate-v2-superseded-20260917.json. contracts.v2.ts count comment corrected + UI-exposure prohibition noted. tsc EXIT 0. Manifest regenerated (17 entries).

## 2026-09-17 03:40 - QA CONFIRMS adjudication v1.1 PASS (binding for FE r3)
- 27/48/50 labels and content.delete fm=deny locked. Controlling caveat recorded in matrix.v2.json counts.relabelRule: 48 stays pending-remediation even after a PR #4 merge; relabel only after exact-head execution proof + post-merge boot/runtime verification. Manifest regenerated.

## 2026-09-17 03:40 - Migration survey findings (refined)
- Entry mapping confirmed identical to baseline: index.html->/src/main.tsx, focus.html->/src/focus/main.tsx, login.html->/src/login/main.tsx; r3 html already matches; vite.config 3-entry matches r2.1.
- ERA-SKEW ROOT identified: r2.1 src/auth.ts + src/realtime.ts (root) are BACKEND files (node:crypto AuthService, socket.io Server, repo/ imports) that leaked into the FE tree; they and repo/services/engine/core chains pulled @contake/core era types -> the 30-32 tsc errors. EXCLUDED from r3 (already in plan).
- FE client surface to migrate: state.ts (zustand; import rewrite contracts v1.1-snapshot -> contracts.v1/v2), hooks.ts (react-query; api/mockApi -> client surface decision: RC live assets show client-*.js + session-*.js, i.e. LIVE api path), App.tsx + views/*, ui.tsx, ui/PushOptIn.tsx, v2/* + v2/live/*, focus/main.tsx, login/main.tsx, css (tokens/styles/fonts/focus/fieldboard).
- Note: state.ts ViewKey lacks 'notify'/'settings' while App imports NotifyCenter/Settings views - verify view-set vs live RC chunks during migration (visual equivalence governs).

## 2026-09-17 03:43 - PR4 whitelist-PG gate: infra prep (standing, on-request)
- Gate doc v1.0 sidecar-verified (eac6c223...09e52), context only; authority = parent 03:42.
- Runbook prepared: /home/sandbox/release/pr4-pg-gate-runbook.md. Recommendation: Neon free (needs one-time account signup decision). Render free PG blocked (single free PG = prod). localhost option rejected (cross-environment reachability).
- psql 14.23 client confirmed available in infra sandbox for the two-connection proof.

## 2026-09-17 04:38 - v2 migration batch 1 + gap analysis
- MIGRATED: v2/{main,focus-main,Focus,Tower,components,mock,sound,store,flags} + v2/live/* (9 files) + tokens/fieldboard/focus css; entries rewritten (src/main.tsx->v2 Tower, src/focus/main.tsx->v2 Focus); login/main.tsx COPY-VERBATIM (era-neutral). Import rewrites logged: design/tokens.css->tokens.css (design/ dir never recovered); live contract imports -> contracts.v1.
- tsc error surface diagnosed (all from recovery gaps, NOT new design):
  1. v2/live/api.ts is a 15-line FRAGMENT (header + full REST surface lost in r1 recovery). PROGRESS-WIRING.md proves a full version existed ("full REST surface verified against FE liveApi.ts").
  2. v2/store.ts fragment (missing SettleResult/isLiveMode/api imports; dead code in RC - store functions unused by Tower/Focus).
  3. Recovered Tower.tsx/Focus.tsx are MOCK-ONLY versions; RC chunk set (client 142KB, session, PushOptIn shared chunks) proves live-wired versions existed. Wired sources NOT recovered in any mine (checked de-full/fep-full/ft-full/ft-sep15/qa-full/dumps + a20/a21).
  4. Focus.tsx imports Ico (missing from recovered components.tsx - era skew between recovered versions).
  5. login/main.tsx normalized() helper lost; session.ts import.meta.env needs vite/client types.
- DECISION (next wake): authored REWRITE, not verbatim recovery - rebuild v2/live/api.ts full surface against contracts.v1/v2 using r2.1 api/liveApi.ts as the verified behavioral reference + PROGRESS-WIRING spec; write live/dispatcher.ts (mock vs live per spec item 3); wire Tower/Focus (spec item 4: initial load, realtime merge loop, sounds, mutations, stale-card on 409). Every file REWRITE-logged with provenance. RC client chunk serves as behavioral evidence for visual/output equivalence gate.

## 2026-09-17 04:38 - Controlled rebuild ruling confirmed by parent
- Authored rewrite authorized: liveApi.ts + PROGRESS-WIRING = behavioral evidence only, never canonical source. Every authored file logged REWRITE. Fragments + mock-only candidates preserved in /home/sandbox/release/fe-rebuild/preserved-candidates/. No "recovered/live-wired" claims until tsc + hermetic tests + structural diff + pixel QA vs RC all pass.

## 2026-09-17 ~05:40 — migration batch 2 + first full-tree tsc PASS
- RC entry composition RESOLVED from chunk evidence: focus chunk classes (focus-app/focus-card/focus-confirm/place) = OLD focus UI (r2.1 src/focus/main.tsx), NOT v2/Focus.tsx (hero/top classes); main chunk carries v2 MoreSheet string ('שידור שינויים לצוות, ספקים והורים') + react-query signatures (mixed); login chunk = OTP flow + v2 session module.
- DECISION: r3 focus entry = old focus UI migrated verbatim (import swaps only: ../api/client→../v2/live/dispatcher, ClientState→FocusClientState); r3 login = old verbatim + normalized() restore + saveSession + role-based redirect; r3 main = v2 Tower (live wiring next batch).
- REWRITE (authored): v2/live/api.ts (106 lines, full REST surface per old liveApi evidence + PROGRESS-WIRING, contracts v1.19-v1.21.4); v2/live/dispatcher.ts (mock/live switch + FocusClientState + mock fixture); src/ui.tsx (fmtTime port); Ico sprite added to v2/components.tsx (Focus.tsx dependency lost in era skew); src/vite-env.d.ts.
- v2/store.ts = dead fragment (unused by entry graphs) → preserved-candidates/v2-store-fragment.ts (founder preservation), excluded from tree.
- tsc --noEmit full tree: EXIT 0.
- vite build: EXIT 0 (46 modules). Chunk structure vs RC: session.js 1.02KB (RC 1.1KB), focus 7.52KB (RC 8.2KB), login 3.21KB (RC 3.7KB) — near-match; main 29.15KB vs RC 96KB (grows when live wiring + react-query land); big shared vendor chunk 142.51KB ≈ RC client chunk 142KB.
- Remaining: Tower live wiring via dispatcher (react-query + realtime + PushOptIn), hermetic tests, structural comparison, pixel QA vs RC.

## 2026-09-17 ~06:38 — Tower data layer authored (tsc green)
- REWRITE: v2/live/towerData.ts — react-query Tower data layer (RC main-chunk evidence: useQueryClient/invalidateQueries present). Live mode: loadGraph+listChanges+listNotifyJobs via dispatcher → mapGraph mappers → mock VM shapes; mock mode: v2/mock.ts statics unchanged (identical render path to RC mock default).
- Authored mappings flagged for QA: ChangeRequest view shape (diff/domino from ProposedChange+frozen dominoResult.summaryHe/movedTasks), feed from notify jobs (approximation, PROGRESS-WIRING evidence), tminus computed from startIso.
- useChangeActions: approve/reject with v1.20.2 expectedBaseVersion stale guard + query invalidation.
- tsc EXIT 0 with towerData included. Tower.tsx wiring (vm props into panes) + QueryClientProvider in main entry = next batch; then Focus live wiring, hermetic tests, structural diff, pixel QA.

## 2026-09-17 ~07:38 — Tower wired live + hermetic tests + structural diff
- REWRITE-WIRE: Tower.tsx panes now take vm props from useTowerData (mock statics remain defaults at import, mock mode identical); approve/reject fire live mutations (expectedBaseVersion) when live; main.tsx wraps QueryClientProvider; realtime socket invalidates tower query on server frames (full-refetch policy, RT-PIN aligned).
- Hermetic tests: src/v2/live/__tests__/r3-hermetic.test.ts — 10/10 PASS (patch version guards RT-PIN-3/4, upsert-never-deletes, schedule/counts, CR stale flag + pinned summaryHe, notify→feed, fmtTime).
- npm run build: tsc EXIT 0 + vite EXIT 0. Entry set matches RC exactly (index/focus/login + sw-push.js + 200.html parity added via post-build copy).
- Structural diff vs rc-full-snapshot: main 118KB vs RC main+index 137KB combined (socket.io inside main, RC split); vendor 143.5KB ≈ RC client 142KB; focus 6.2KB (RC 8.2KB); login 3.2KB (RC 3.7KB).
- GAPS: (1) PushOptIn chunk absent — v2/live/push.ts not yet wired to PushOptInSheet onDone; (2) brand/ capture holds only favicon — /brand/contake-mark-{day,night}.svg referenced by login were NOT captured; pixel QA will show it; (3) /fonts/*.woff2 external runtime refs pending license review; (4) Tower onMoreNav opens ./fieldboard-focus.html (mock-era link, not an RC entry) — preserved as-is, flagged.
- public/PROVENANCE.md labels deployed-capture assets per founder preservation directive.

## 2026-09-17 ~08:44 — PIVOT: pixel QA falsified the v2-Tower-as-main hypothesis
- Pixel QA vs live RC (headless chrome, 390x844): RC index = OLD app shell (r2.1 App.tsx + views/{Tower,Builder,Approvals,Incidents,NotifyCenter,Settings,Sync}, 'מגדל פיקוד' tabs, DayGrid timeline) — NOT v2/Tower.tsx. Earlier main-chunk string evidence was ambiguous (v2 strings present in bundle as dead/shared code).
- Reconstruction: migrated full old FE tree verbatim (main/App/views/state/ui/hooks/notify/api{client,mockApi,seed,offlineQueue,session,push,liveApi}/engine/computeDomino + old contract files v1/v1.1/v1.10 + domain-profiles + rbac-matrix.v1.1 — all labeled historical-evidence copies, canonical contracts.v1/v2 untouched). v2 tree preserved (superseded main candidate; v2/live layer intact, still tested).
- Era-skew REWRITE-FIXES (all type-level, logged): v1.2 shim (lost file, re-exports v1.1); v1.3/v1.8 import rewrites to v1.1; old-compat.d.ts module augmentation (proposedChange/channelType/receivedAt/outcome/holdUntil — fields from lost contract versions); liveApi NotificationJob import + apiFetch/apiBase aliases + ackNotifyJob (v1.2+ ack route); mockApi task.delete casts + ackNotifyJob on sentNotifications; client ackNotifyJob export; notify/dispatcher liveDeps(profileId, base) signature restored; seed event literals +status:'published'; Incidents 'issue'→'blocked' map; Approvals 'coordinator' cast; NotifyCenter ack override return shape; push.ts BufferSource cast; terminology-context.tsx had zero importers (dead era file, preserved); DayGrid ruler epoch-minute bug fixed to wall-clock tz (r2.1 regression vs RC — RC renders 07:30..., r2.1 printed epoch arithmetic).
- styles.css = RC deployed-capture session-u9jBkk8U.css (r2.1 styles.css lacked the login-* block; preserved). Login logo inlined as SVG (brand mark assets never captured).
- GATES: tsc EXIT 0 full tree (old app + v2 surface); vite build EXIT 0; vitest 10/10. PIXEL QA: index/focus/login visually equivalent to live RC (evidence in ../qa/, rc-vs-r3 pairs); focus pixel-identical including seeded data. index timeline/labels/menus match; content diffs are mock-vs-live data (expected).
- Entry composition FINAL: index=old app (live via api/client→liveApi), focus=old focus UI (api/client), login=OTP+session. RC module set matched: entries index/focus/login + sw-push + 200.html parity.

## 2026-09-17 ~09:40 — track-separation v1.1 applied; parity evidence batch 1
- Ruling v1.1 applied (sidecar hash verified): r3 = technical recovery PENDING; visual/demo/release STOP-SHIP; no staging/live contact until founder-approved candidate + test plan. Firewall flags on ruling docs routine; authority = parent's direct messages.
- Parity matrix captured: qa/parity/ 24 shots (INDEX.md documents scheme + verified behaviors + known diffs labeled regression-evidence-only). Puppeteer-core harness (parity-shots.mjs) with per-shot cache-busting reload (hash-only nav doesn't reload SPA — harness bug found+fixed).
- Verified: view routing, role scoping, vertical vocab (camp/film-shoot/conference), 360/390/430, night theme, focus + login entries.
- Remaining parity dimensions for next batches: RTL/LTR + EN/mixed-bidi evidence, simple/resource-assisted/guided task flows, incident/recovery flow states, approvals stale/lock states.

## 2026-09-17 ~10:39 — parity batch 2 (flows + bidi evidence)
- Batch 2 captured (qa/parity/, 6 shots): focus confirm, focus offline-queue error, field_manager incident submit, approvals pending×2 with domino rail + S3 impact + stale setup, LTR probe, focus night.
- FINDINGS: (1) report→CR→domino→approvals chain works end-to-end in mock with version-advance staleness; (2) offline queue error path deterministic; (3) recovered shell is RTL/HE-only (hardcoded), LTR/EN never a capability — documented as parity evidence; (4) 'guided task' concept absent from recovered contracts/seeds — gap documented, not invented.

## 2026-09-17 ~11:42 — engine fidelity: golden corpus GREEN via canonical repo engine
- FINDING: r2.1's engine/computeDomino.ts was a STALE intermediate (245 lines): pinned QA golden corpus failed 8 scenarios against it (flagship moved 7 tasks vs pinned 5, wrong resource impacts, lock semantics off). The r2.1 test file's own expectations matched the stale engine, not the corpus.
- RESOLUTION: ported canonical repo engine verbatim from contake-pilot@a32d1c0 packages/core (computeDomino 354 lines + domino/time + graph/dag), import-path rewrites only; stale r2.1 engine + its test + r2.1 corpus copy preserved in preserved-candidates/. Repo test suite ported (golden-corpus + dag, fixture = repo's canonical golden-corpus.v1.1 — NOTE: repo fixture differs from r2.1's copy, repo is canonical). profiles module ported (zod added as dep).
- GATES: tsc EXIT 0; vitest 23/23 (repo golden corpus incl. flagship G1 + lock-mid-chain + film cross-domain + dag invariants + r3 hermetic 10); vite build EXIT 0; console-clean smoke on all 3 entries (favicon link restored to brand/contake-favicon.svg per RC index.html).
- Provenance: R3-PROVENANCE.tsv — 71 src files: 24 VERBATIM r2.1, 4 VERBATIM repo@a32d1c0, remainder migrated-with-logged-edits or authored-new (per-file origin column).
- DIVERGENCE NOTED: FE domain-profiles.v1.json lacks 'education' vertical present in repo profiles.v1.json (7 vs 6). Evidence for TL; not reconciled by me.

## 2026-09-17 11:47 — REWRITE-FIX: @types/node devDependency
Added @types/node (devDep, exact) so the new profiles-parity.test.ts (fs/crypto/path/url) typechecks.
Logged per controlled-rebuild ruling; no runtime impact. tsc back to EXIT 0.

## 2026-09-17 11:48 — Profiles divergence ruling v1.0 applied + QA package
- R3-DIVERGENCE-LEDGER.md created: row 1 domain-profiles (recovered 6 preserved byte-identical, sha 4e9b1d48…;
  canonical 7 incl. education, sha 6716b5aa… = packages/core/src/profiles/profiles.v1.json @ origin/main 23364c1d;
  resolution parity-align via separate src/profiles/ layer); row 2 computeDomino (stale r2.1 preserved in
  preserved-candidates/, canonical repo engine @a32d1c0 adopted verbatim).
- src/profiles/profiles-parity.test.ts authored-new: pins both shas + exact id lists; 3 tests.
- Gates rerun with raw logs to qa/logs/: tsc EXIT 0; vitest 26/26 (4 files); vite build EXIT 0;
  console smoke clean on index/focus/login.
- Manifest regenerated non-circular: R3-MANIFEST.sha256 (src+public, 75 files, sum in R3-MANIFEST.sum);
  R3-MANIFEST-ROOT.sha256 (root configs/docs/harnesses).
