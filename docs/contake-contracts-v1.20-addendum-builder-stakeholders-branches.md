# Contake Contracts — תוספת v1.20 (drop-in, additive-only)
**תאריך:** 17.9.2026 | **בעלים:** TL בלבד | **מצב:** טיוטה לריוויו — לא ליישום לפני אישור
**שורש:** שכבה A של המסלול המתוקן (Builder, תוכן, בעלי עניין חיצוניים, סניפים). כל הסעיפים additive; לא נוגע ב-v1.19 וקודמיו. sha manifest מצורף בנפרד בעת המסירה.

## §20 — Content surface (פורמליזציה של C-i-C v0.1 §2)
ישויות: ContentItem, TaskResource כפי שסופק ב-v0.1 §2, ללא שינוי.
- Actions (additive, matrix v1.7): content.create / content.update / content.delete / content.attach / content.read. כתיבה: manager+; קריאה: תפקיד משובץ ב-scope בלבד. Action count 32 → 37.
- AuditEntityType += 'content_item'. create/update/attach/ack מתועדים.
- `GET /v1/focus/now` → { currentStep, nextStep, visibleResources[], window }. הרחבה של הקיים, לא החלפה. משימה פשוטה מחזירה visibleResources: [] תמיד (progressive disclosure בחוזה).
- versioning: עדכון תוכן אחרי פרסום = version חדש; Focus תמיד מקבל את העדכנית בחלון הפתוח.
- offline: ack/checklist באותו תור של reports, עם clientAckId (idempotent, §17). Read cache של הצעד+תוכן האחרון.
- file blobs: חסום. file=external URL בלבד באלפא; סוג file לא נחשף ב-Builder עד שהתשתית קיימת. אין placeholder.

## §21 — Builder authoring routes
ה-API תומך יצירה (ה-harness מוכיח); הסעיף מפורмал את משטח ה-authoring המלא שה-FE בונה עליו:
- `POST /v1/orgs/:orgId/events` — יצירת אירוע (קיים; ננעל כחוזה: שדות, שגיאות, idempotency-key חובה לפי §17).
- `POST /v1/events/:eventId/days` — יצירת יום (additive; מקביל ל-seeds של היום).
- `POST /v1/days/:dayId/tasks` — משימה: { title, startTime, endTime, assigneeIds[], locationId?, dependsOn[], locked: bool, hardConstraints[] }. תשובה: task + computedWindow.
- `PATCH /v1/tasks/:taskId` — עריכה; שינוי זמן/תלות מפעיל domino recompute סינכרוני (אותו מנוע, אותה תשובת impacted כמו ב-reports).
- `POST /v1/tasks/:taskId/resources` — שיוך משאב (צוות/ציוד/מיקום/ContentItem). resourceKind enum: staff | equipment | location | content.
- `POST /v1/tasks/:taskId/deps` / `DELETE .../deps/:depId` — תלויות; רק רכיבים חוקיים (אין מעגלים — השרת דוחה 409 עם cyclePath).
- נעילים (locked/🔒): שינוי שמפר אילוץ קשיח נדחה 409 עם reasonCode='HARD_CONSTRAINT'; הדומינו לעולם לא שובר נעיל (אימות ratchet קיים).
- כל הכתיבות: version fields קיימים, אימות הרשאות לפי matrix (manager+ ברמת האירוע; Field Manager מקומי בלבד, שינוי רוחבי → approval לפי RBAC הקיים), idempotency-key חובה.
- שגיאות: 400 validation, 403 scope, 409 conflict/constraint, 422 business — אותה צורת שגיאה כמו שאר v1.

## §22 — External stakeholders (נמענים חיצוניים)
הגדרת מייסד 10.9: ספקים ולקוחות/הורים הם חלק מה-sync. התשלומי SMS/WhatsApp נדחו בהחלטתו (11.9 14:06) ונשארים מחוץ לסעיף זה.
```
ExternalParty { id, orgId, kind: 'guardian'|'supplier'|'client', displayName,
  contactRefs: [{ channel: 'in_app'|'whatsapp_stub'|'sms_stub', value }],
  links: [{ entity: 'event'|'task'|'participant', entityId, relation }],
  consent: { status: 'pending'|'granted'|'revoked', at }, createdAt, version }
```
- נמענות: בחישוב דומינו, המנוע מרחיב את רשימת הנמענים ל-ExternalParties מקושרים (participant→guardian וכו'). הודעה: in_app directed (ביתי, עובד היום) + רישום delivery לכל ערוץ stub עם status='not_sent_transport_deferred'.
- אין שליחה אמיתית לערוץ חיצוני עד אישור מייסד נפרד (תשלום/אישורים) — stub בלבד, מתועד, לא מזויף כ"נשלח".
- Actions += stakeholder.create/update/delete/link/read (manager+ בלבד; קריאה ל-manager בלבד — פרטיות נמענים). Action count 37 → 42. AuditEntityType += 'external_party'.
- הרשאות: ExternalParty לעולם לא רואה את המערכת — הוא נמען בלבד באלפא. אין login לנמען חיצוני בגרסה זו.
- בידוד טננטי: שיוך orgId מלא; שאילתות לפי org בלבד (חוקה §4).

## §23 — Branches (סניפים)
הגדרת מייסד 10.9: "ניהול מרכזי של אירועים, סניפים... במטריצה אחת".
```
Branch { id, orgId, name, location?, active, createdAt, version }
Event.branchId?  // additive, nullable — אירוע קיים בלי סניף נשאר חוקי
```
- `GET /v1/orgs/:orgId/matrix?from&to` → אירועים/ימים/משימות מקובצים לפי branchId (ולא מקובצים לסניף-כל). זו המטריצה האחת: קריאה בלבד באלפא.
- Actions += branch.create/update/archive/read (manager+). Action count 42 → 46. AuditEntityType += 'branch'.
- לא באלפא (backlog, מפורש): domino חוצה-סניפים, שיוך צוות לסניף, הרשאות ברמת סניף.
- דומינו: היקף חישוב נשאר פר-אירוע. אין שינוי למנוע.

## כללים חוצים
- Additive-only: שום שדה/פעולה קיימים לא משתנים; ביטולים רק דרך §18 (ממתין לאישור מייסד).
- כל כתיבה: idempotency-key (§17, שער קשיח כשה-backend מיישם), version, audit.
- שערי קבלה: E2E על כל סעיף (§4 של C-i-C לתוכן; תרחיש Builder מלא; הרחבת נמענים עם guardian; matrix query) + QA labels מחייבות + פסיקות חמשת צירי האיכות.
