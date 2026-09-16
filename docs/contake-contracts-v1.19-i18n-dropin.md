# Contracts v1.19 DROP-IN — i18n (bilingual he/en) [ADDITIVE, TL-owned]
**Base:** contracts v1.18 (contracts.v1.ts sha 4c6629a788b33e604b75ff69a3f9ea5882225221d4a5d2e1bfe25e1ab0c9e761, CONTRACTS_PINNED.json pinned_version 1.18)
**Rule check:** additive only; zero behavior change for existing clients (default locale he); no frame/endpoint removed or reshaped.
**Status:** authored 2026-09-16; implementation AFTER Thursday demo gate closes; bilingual support is a HARD GATE for the next promoted release.

## Changelog v1.19 (to prepend at contracts.v1.ts header)
```
 * v1.19 changelog (bilingual he/en, ADDITIVE - product owner requirement relayed via main, 2026-09-16):
 *    Next promoted release must ship native Hebrew RTL + English LTR.
 *    + Locale type ('he' | 'en'); UserProfile gains optional locale (default 'he').
 *    + User settings endpoints (self-scope): GET/PATCH /v1/users/me/settings.
 *    + Action gains 'user.update-settings' - matrix bump v1.4 -> v1.5, one additive
 *      row (all roles allow, scope=self). Action count 30 -> 31.
 *    + Outbound notification templates are KEYED: dispatch renders per-recipient
 *      locale (fanout stays dispatch-time per v1.16 push pin); stored in-app rows
 *      carry {key, params, rendered per recipient locale}.
 *    + Domino summaries in API responses gain structured form {code, params} so
 *      clients render localized text; push/SMS channels render server-side per
 *      recipient locale.
 *    + Terminology registry entries become bilingual {he, en}: registry v1.4.
 *    ~ No realtime frame changes; settings are user-local.
 *    ~ Audit: settings change audited entityType 'user', action 'user.update-settings'.
```

## Section 16. BILINGUAL SUPPORT [v1.19]
```ts
export type Locale = 'he' | 'en';

export interface UserProfile {
  // ...existing fields unchanged
  /** v1.19 - display/notification language. Absent => 'he'. */
  locale?: Locale;
}

/** v1.19 - keyed outbound message. `key` names the template; `params` are
 *  locale-neutral values (names, minutes, times). Server renders per-recipient
 *  locale at dispatch (push/SMS) and stores rendered + {key, params} for in-app. */
export interface NotifyMessage {
  key: string;                       // e.g. 'domino.impact', 'task.assigned'
  params: Record<string, string | number>;
}

/** v1.19 - structured domino summary. `text` remains for backward compat
 *  (Hebrew, as today); clients SHOULD render from code+params in user locale. */
export interface DominoSummaryLocalized {
  code: string;                      // e.g. 'domino.none', 'domino.cascade', 'domino.conflict'
  params: Record<string, string | number>;
  text: string;                      // legacy Hebrew rendering, unchanged
}

/** v1.19 - bilingual registry term (registry v1.4). */
export interface TermEntry { he: string; en: string; }

/** Endpoints (matrix v1.5 row: user.update-settings = all roles allow, scope self):
 *    GET   /v1/users/me/settings            -> { locale: Locale }
 *    PATCH /v1/users/me/settings { locale } -> { locale: Locale }   user.update-settings
 *  PATCH is audited (entityType 'user'). No other role may set another user's locale. */
```

### Action union addition (keep in sync with matrix rows)
```
  | 'user.update-settings';   // v1.19 - matrix v1.5, all roles allow scope=self
```

## Explicit non-changes
- No change to whitelist section 15, push pins, auth, RBAC rows, realtime frames.
- Hebrew stays default everywhere; an absent `locale` reads exactly like today.
- Demo seed CONTENT stays Hebrew in v1.19; bilingual seeds are a separate work item, not a contract change.

## Manifest
- File to patch: packages/core/src/contracts.v1.ts (header changelog + section 16 + Action union + matrix.v1.json bump v1.4->v1.5 with one row).
- sha256 of THIS drop-in spec: see delivery message.
