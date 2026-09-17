# Unified archive transport chain (founder preservation directive 2026-09-17)

Active unified archive: 0247 (extracted into canonical paths per docs/REGISTRY.md).
Transport tarballs retained byte-identical per protocol: "not used" never means disposable.

| Transport | sha256 | Lifecycle | Findings |
|---|---|---|---|
| contake-archive-0242a-106b2376.tar.gz | 106b2376cc699f124916bc75ffcaa2386dcb2f24712fd3c02e59ae28f89b80e7 | superseded | First unified (02:42); rebuilt after infra/release addition |
| contake-archive-0242b-b1838ead.tar.gz | b1838eadf6db85e6afbd56e7dd59fe548e86ec4a74b7b9bdb5ac3a6039b030bc | superseded | Added infra/release; superseded for registry-completeness fixes |
| contake-archive-0243-03678028.tar.gz | 03678028d772ca35304fc3181dc6da6e2960caf11be810ebf4789574b188298b | rejected | QA: structurally invalid |
| contake-archive-0244-e9e7fd2a.tar.gz | e9e7fd2ae9fdf43c8847366dc846550f7b83495fc0515e462471499b8590b562 | rejected | Backend strict validation: circular manifest self-entry (empty-sha e3b0c442... placeholder, checksum exit 1), duplicate DELETION-LOG.md registry row, 59 rows vs 55 files, 3 unreconciled names; QA concurred (generator defects) |
| contake-archive-0245-9b345701.tar.gz | 9b3457012f162757990269aab19a946c1b11be5f6bbf2a97bfa3557b60c4b097 | superseded | QA reviewed; superseded by 0246 candidate |
| contake-archive-0246-6f01408f.tar.gz | 6f01408f87a07f998d0a7c520e149ffa4773b1cedc36882ccfe7d8e6425f5927 | superseded | QA: archive content passed; deterministic-generator claim rejected, announced generator hash wrong |
| (active, not stored here) 0247 | 2428869108f70a48c2f34b4d82d5e2e3e3829b2e71ee20401dbe87a9879655d0 | active | Independent QA PASS (T1-T8, byte-reproducibility); extracted to canonical paths; sidecar in artifacts/control/ |

Generator history: archive-gen v1.1 (tar 0058aac4) REJECTED (QA: determinism claim + announced hash wrong); portable corrected generator (b8cd9a3c...) retained in artifacts/generator/.

## Corrections

- 2026-09-17 (TL, additive): the 0246 row's Findings text is corrected. Verified fact: 0246 FAILS generator v1.2 test T8 (root '.' entry present; 56 members vs expected 55) — do not claim 0246 passes. The deterministic-generator claim was rejected and its announced hash was wrong. The original row above is preserved unedited for history.
