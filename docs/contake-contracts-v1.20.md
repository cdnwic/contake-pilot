# Contake Contracts — v1.20 (מאושר ליישום על dev branches; additive-only; מותאם ל-main ef65394)
**תאריך:** 17.9.2026 | **בעלים:** TL בלבד | **מצב: APPROVED ל-dev בלבד. staging קפוא.**
**מבטל ומחליף:** טיוטת 02:28 (123ea918) וגרסת 02:29 (9072f5a7) — שתיהן בוטלו; אין ליישם מולן.
**מקורות ריבוי:** repo main @ ef65394 (app.ts, contracts.v1.ts, matrix.v1.json v1.4/27 actions); PQM-5 run rmu4qeobs; E2E route evidence (17.9); הגדרות מייסד 10-11.9.

## כללי יסוד (קשיחים)
1. **Additive-only:** שום route, שדה, enum או קוד-סטטוס קיימים לא משתנים. ביטולים רק דרך §18 (ממתין למייסד).
2. **Route coexistence:** routes קיימים נשארים כמות שהם; כל route בסעיף זה הוא net-new ומסומן [NEW]. אין כפילות, אין rename.
3. **Enum compatibility:** ResourceKind נשאר 'person'|'equipment'|'location'|'group' (contracts.v1.ts:126). תוכן אינו resourceKind — הוא ישות נפרדת המקושרת ל-taskId.
4. **§17 sequencing:** routes קיימים לא מקבלים דרישת idempotency חדשה. routes כתיבה [NEW] ב-v1.20 נושאים clientMutationId ב-body עם dedupe צד-שרת (אותו תבנית clientReportId הקיימת ב-POST /v1/reports, app.ts:933). POST /v1/events הקיים *לא* דורש Idempotency-Key (E2E verified); תמיכת header אופציונלית תתווסף עם יישום §17 הכולל — שער קשיח כפי שהוחלט, לא שינוי חוזה כאן.
5. **שגיאות:** צורת fail() הקיימת. דחיית מעגל תלות נשארת **400 DEPENDENCY_CYCLE** (E2E verified) — תוספת additive בלבד: details.cyclePath: ID[].
6. **יום (Day):** אין ישות Day ב-main; Event.date + siteIds. "יום חדש" (מייסד, 13.9) ממופה ל-Event נוסף באותו org. recurrence/multi-day = backlog #1, לא בסעיף זה.

## §20 — Content surface [NEW] (G4 stop-ship; C-i-C v0.1 §2 מצורף מילולית בנספח א')
ישויות:
```
ContentItem { id, orgId, kind: 'text'|'link'|'checklist'|'equipment'|'form',
  title, body?, url?, checklistItems?, meta, createdBy, createdAt, version }
TaskResource { taskId, contentId, role: 'instructions'|'script'|'checklist'|'equipment'|'form',
  visibleFromOffsetMin, visibleUntil?, ackRequired? }
```
(נספח א' הוא המקור המלא: חלונות visibility, derived tier, offline ack, אין שכבת program.)
Routes [NEW]:
- POST /v1/orgs/:orgId/content — יצירת ContentItem (clientMutationId).
- PATCH /v1/content/:id — version++ חובה אחרי פרסום; audit.
- DELETE /v1/content/:id — §18 pending; עד אז: hard delete admin בלבד, audit.
- POST /v1/tasks/:id/content — צירוף (TaskResource, clientMutationId). 404 על task לא קיים.
- DELETE /v1/tasks/:id/content/:contentId — הסרת קישור בלבד, לא מחיקת פריט.
- GET /v1/focus/now — [NEW, לא הרחבה של קיים; אין route כזה ב-main] → { currentTask, nextTask, visibleResources[], window }. משימה פשוטה → visibleResources: []. ה-worker flow הקיים (GET /v1/events מסונן linkedResourceId) נשאר; focus/now משטח נוסף.
- offline ack: POST /v1/content/:id/ack — body: { clientAckId, taskId } dedupe כמו clientReportId.
Actions (matrix v1.5): content.create/update/delete/attach/read/ack — ראה §M.
AuditEntityType += 'content_item'.
file blobs: חסום. file=external URL בלבד; סוג file לא נחשף ב-Builder. אין placeholder.

## §21 — Builder authoring (coexistence מלא; G-founders: 11.9 12:05, 13.9 23:28)
**המשטח כבר קיים ברובו ב-main** — החוזה נועל התנהגות, לא מוסיף routes (חוץ מהמסומן):
- POST /v1/events — קיים. ננעל: כיום ללא Idempotency-Key (E2E verified); נשאר כך בגרסה זו.
- POST /v1/events/:id/tasks — קיים (דרישות: name, durationMin, siteId; start עם offset; app.ts:692). ננעל.
- PATCH/DELETE /v1/tasks/:id — קיימים. שינוי זמן/תלות מפעיל domino recompute דרך ProposedChange הקיים.
- POST /v1/events/:id/resources, PATCH/DELETE /v1/resources/:id — קיימים. ResourceKind ללא שינוי.
- POST /v1/events/:id/dependencies, DELETE /v1/dependencies/:id — קיימים. דחיית מעגל: 400 DEPENDENCY_CYCLE + [additive] details.cyclePath.
- POST /v1/events/:id/publish, /duplicate, GET /v1/events/:id/graph — קיימים.
- אילוצים קשיחים: TaskNode.locked קיים; POST /v1/tasks/:id/lock|/unlock קיימים (matrix: constraint.lock/unlock). הדומינו לעולם לא מזיז locked (ratchet מאומת).
- סמנטיקת כתיבה: כל המוטציות דרך proposeMutation — admin=allow מיישם מיד, field_manager=scope/propose לפי matrix. Builder ב-FE חייב להציג מצב "ממתין לאישור" על CR — זו התנהגות קיימת, לא חדשה.
- **הפער האמיתי הוא FE בלבד:** אין מסך Builder. העבודה: FE על dev branch מהריפו הקנוני (infra), מול routes קיימים + §20 [NEW].
- GET /v1/orgs/:orgId/matrix?from&to — [NEW] קריאה בלבד: events/tasks מקובצים לפי branchId (ראה §23).

## §22 — External stakeholders [NEW] (G2/G3/G6; דרישת כוונת-מייסד: הגדרת 10.9 18:29 — ספקים ולקוחות/הורים. תשלומי SMS/WhatsApp מדחיינים בהחלטתו 11.9 14:06)
Coexistence: ResourceNode.subscriberChannelIds קיים ונשאר; ExternalParty הוא המודל המוסכם-עליו (consented) החדש. אין migration בגרסה זו.
```
ExternalParty { id, orgId, kind: 'guardian'|'supplier'|'client', displayName,
  contactRefs: [{ channel: 'in_app'|'whatsapp'|'sms', value, transport: 'deferred' }],
  links: [{ entity: 'event'|'task'|'resource', entityId, relation }],
  consent: { status: 'pending'|'granted'|'revoked', at }, createdAt, version }
```
- **פרטיות (אותה מחלקת דליפה כמו contactPhone/subscriberChannelIds, contracts.v1.ts:172,422):** contactRefs גלויים admin/field_manager בלבד; לעולם לא ב-realtime frames, לא ב-payloads ל-focus_worker, לא ל-ExternalParty אחר.
- **consent:** revoked משתיק כל מסירה ל-contactRef; dispatcher מסמן record 'suppressed_consent_revoked'. pending = ברירת מחדל; מסירה in_app directed מותרת ב-pending (זה ערוץ ביתי, לא חיצוני).
- **מסירה:** חישוב דומינו מרחיב נמענים ל-ExternalParties מקושרים (resource.links). in_app directed פעיל; whatsapp/sms = transport:'deferred' — delivery record עם status='not_sent_transport_deferred'. אין שליחה חיצונית אמיתית ללא אישור מייסד.
- **G3 ספק (אלפא):** supplier מקושר ל-task/event מקבל עדכוני in_app directed. אין login, אין דף ספק.
- **G6 הורה (אלפא):** GET /v1/public/status/:accessToken — [NEW] קריאה בלבד לאורח: לו״ז+סטטוסים של ה-participant/הקבוצה המקושרים בלבד. token יוצר manager (admin/fm), revocable, אין PII מעבר לשם המשתתף והלו״ז. ללא action במטריצה (משטח ציבורי מבוסס-token, לא role).
Routes [NEW]: POST/PATCH/DELETE /v1/orgs/:orgId/stakeholders(/:id), POST /v1/stakeholders/:id/links, GET /v1/stakeholders (manager+), POST /v1/stakeholders/:id/status-token, DELETE /v1/status-tokens/:id.
Actions: stakeholder.create/update/delete/link/read — admin allow; field_manager: read=scope, write=deny (פרטיות, תבנית whitelist.*); focus_worker deny. ראה §M.
AuditEntityType += 'external_party', 'status_token'.

## §23 — Branches [NEW] (הגדרת 10.9: "סניפים... במטריצה אחת")
```
Branch { id, orgId, name, location?, active, createdAt, version }
EventNode.branchId?  // additive, nullable; אירוע קיים חוקי
```
Coexistence עם siteId: site הוא **ברמת אירוע** (EventNode.siteIds, Scope); Branch הוא **ברמת org**. אין שינוי ל-site; אין migration; branchId לא משפיע על domino (היקף פר-אירוע נשאר).
Routes [NEW]: POST/PATCH /v1/orgs/:orgId/branches(/:id), POST /v1/branches/:id/archive, GET /v1/branches, GET /v1/orgs/:orgId/matrix (§21).
Actions: branch.create/update/archive — admin allow, אחרים deny; branch.read + org.matrix.read — admin allow, field_manager scope, focus_worker deny.
AuditEntityType += 'branch'.
לא באלפא (מפורש): domino חוצה-סניפים, שיוך צוות לסניף, הרשאות ברמת סניף.

## §24 — Field report surface [NEW] (G1 stop-ship; PQM-5: report 200, אפס התראה, read 404)
- GET /v1/reports?eventId=&status=&unread= — [NEW] admin allow, field_manager scope, focus_worker deny. מחזיר דיווחים + read state פר-מנהל. resolve הקיים (POST /v1/reports/:id/resolve) נשאר; ה-ID מתגלה מהרשימה.
- NotificationJob על report status='blocked' — kind חדש additive: 'report_blocked' (NotificationKind += 'report_blocked'). done: מופיע במשטח בלבד, ללא push.
Actions: report.list, report.mark_read — admin allow, field_manager scope, focus_worker deny.

## §25 — Inbound opt-out [NEW] (G2 stop-ship, רגולטורי; PQM-5: handler קיים, route 404/401)
- POST /v1/webhooks/inbound — [NEW] קלט ספק-ניטרלי { channel, from, body }; מנתב ל-handler הקיים ב-dispatch.ts. זיהוי הסרה → ExternalParty.consent.status='revoked' (או יצירת רשומת suppression אם המספר לא מודלח עדיין) + audit.
- אכיפה ב-dispatcher לפני כל מסירה (§22). consent הוא מצב מערכת — עובד גם כשהתשלומי ערוצים מדחיינים.
- ללא action במטריצה (webhook מכונת-ספק, לא role). אימות חתימת ספק — בהתאם לספק עתידי; בינתיים shared-secret header.

## §M — RBAC matrix v1.5 (additive; v1.4 בתוקף, 27 actions → 45)
הקובץ המלא: matrix.v1.5.additions.json בחבילה. תבנית: כפי task.create (admin allow / field_manager scope / focus_worker deny) ו-whitelist.* (admin allow / אחרים deny) הקיימות.
| action | admin | field_manager | focus_worker |
|---|---|---|---|
| content.create / content.update / content.attach | allow | scope | deny |
| content.delete | allow | propose | deny |
| content.read / content.ack | allow | scope | scope (own-tasks only) |
| report.list / report.mark_read | allow | scope | deny |
| stakeholder.create/update/delete/link | allow | deny | deny |
| stakeholder.read | allow | scope | deny |
| branch.create/update/archive | allow | deny | deny |
| branch.read / org.matrix.read | allow | scope | deny |
NotificationKind += 'report_blocked'; AuditEntityType += 'content_item','external_party','status_token','branch'.
denyByDefault נשאר true; reportApplyRule ללא שינוי.

## שערי קבלה (ללא שינוי במדיניות)
E2E פר סעיף: תרחיש §4 של C-i-C; Builder מלא מול routes קיימים; הרחבת נמענים guardian; matrix query; report list+blocked job; STOP מקצה לקצה (revoked → suppressed). QA labels מחייבות; חמש פסיקות הצירים בלתי-תלויות. Harness של E2E (17.9) הוא הכנה בלבד, לא שער ולא הוכחת יישום.

## נספח א' — C-i-C v0.1 §2 (מילולי, sha מקור 002e177b)
```
ContentItem { id, orgId, kind: 'text'|'link'|'file'|'checklist'|'equipment'|'form',
  title, body?, url?, blobRef?, checklistItems?, meta, createdBy, createdAt, version }
TaskResource { taskId, contentId, role: 'instructions'|'script'|'media'|'checklist'|'equipment'|'form',
  visibleFrom: taskStart - prepOffsetMin, visibleUntil?: taskEnd, ackRequired?: bool }
```
הערות ריבוי ל-v1.20: kind 'file' חסום באלפא (file=external URL בלבד); role 'media' ממוזג ל-'link'; visibleFrom מיוצג כ-visibleFromOffsetMin (server-computed window).
