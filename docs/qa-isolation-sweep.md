# Contake QA — Isolation & IDOR Sweep v1.0 (gate G2)
Charter §5. Runs against staging with two orgs (org-A camp, org-B film-shoot), two sites each, full role set per org.

## ISO-1 Cross-tenant IDOR sweep
For EVERY endpoint in contracts §8, and for every seeded entity id in org-B:
- org-A admin requests org-B entity by id → 403/404 (never 200, never partial).
- org-A field_manager / focus_worker: same sweep.
- List endpoints: assert response contains only caller-org ids (parse and check, not status-only).
- GET /v1/events/:id/graph for org-B event from org-A token → 403/404.
- Socket.IO: org-A client cannot join event:{orgB-eventId} room; assert no graph.patch frames arrive.
- Notifications: org-A change never produces a target address from org-B subscriberChannelIds (AC-ISO-1 / AC-NOT-1).

## ISO-2 Site isolation (field_manager)
- field_manager(site-1) GET graph: response contains site-1 tasks + shared resources only; site-2 tasks absent (AC-ISO-2).
- POST /v1/domino/compute referencing site-2 tasks → 403 (C6 scope-check).
- change queue GET /v1/changes?eventId=: field_manager sees own-site CRs only; admin sees all.

## ISO-3 Token hygiene (AC-ISO-3)
- Revoke focus_worker session mid-task → next API call 401; socket room disconnected.
- Role change field_manager→focus_worker: within bounded time (assert ≤ access-token TTL), old-scope calls 403.
- OTP endpoints: rate limit (Throttler-equivalent) — 6th request in window → 429 (SMS-pumping guard).

## ISO-4 Recipient enumeration
- notify dispatch endpoints: no API returns subscriber phone lists to non-admin roles; error responses indistinguishable for existing vs non-existing recipient ids.

## Method note
Every test asserts response BODY content, not just status codes. A 200 with a filtered body is a pass only if the filter is contractual (AC-RBAC-4); a 200 leaking one org-B field is Sev-1.
