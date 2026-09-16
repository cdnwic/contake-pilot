# Contake Contracts — v1.20 (APPROVED, drop-in, additive-only)
**תאריך:** 17.9.2026 | **בעלים:** TL בלבד | **מצב: מאושר ליישום על dev branches בלבד. staging קפוא — שום landing בלי חלון דמו מאושר ושערי §13.**
**מחליף:** את טיוטת 02:28 (sha 123ea918) — הטיוטה בוטלה, אין ליישם מולה. משלב את ממצאי STOP-SHIP של PQM-5 (17.9, run rmu4qeobs).
**שורש:** שכבה A של המסלול המתוקן. כל הסעיפים additive; לא נוגע ב-v1.19 וקודמיו.

## §20 — Content surface (G4; פורמליזציה של C-i-C v0.1 §2)
ישויות ContentItem/TaskResource כפי שסופק ב-v0.1 §2, ללא שינוי.
- Actions (additive): content.create / content.update / content.delete / content.attach / content.read. כתיבה: manager+; קריאה: תפקיד משובץ ב-scope בלבד. Action count 32 → 37.
- AuditEntityType += 'content_item'. create/update/attach/ack מתועדים.
- `GET /v1/focus/now` → { currentStep, nextStep, visibleResources[], window }. הרחבה של הקיים. משימה פשוטה מחזירה visibleResources: [] תמיד.
- versioning: עדכון תוכן אחרי פרסום = version חדש; Focus מקבל תמיד את העדכנית בחלון.
- offline: ack/checklist באותו תור של reports עם clientAckId (idempotent, §17). Read cache לצעד+תוכן אחרון.
- file blobs חסום: file=external URL בלבד באלפא; סוג file לא נחשף ב-Builder. אין placeholder.

## §21 — Builder authoring routes
- `POST /v1/orgs/:orgId/events` — קיים; ננעל כחוזה (שדות, שגיאות, idempotency-key חובה לפי §17).
- `POST /v1/events/:eventId/days` — יצירת יום.
- `POST /v1/days/:dayId/tasks` — { title, startTime, endTime, assigneeIds[], locationId?, dependsOn[], locked, hardConstraints[] } → task + computedWindow.
- `PATCH /v1/tasks/:taskId` — שינוי זמן/תלות מפעיל domino recompute סינכרוני (אותה תשובת impacted כמו reports).
- `POST /v1/tasks/:taskId/resources` — resourceKind: staff | equipment | location | content.
- `POST /v1/tasks/:taskId/deps` / `DELETE .../deps/:depId` — דחיית מעגלים: 409 + cyclePath.
- אילוצים קשיחים: הפרה → 409 reasonCode='HARD_CONSTRAINT'; הדומינו לעולם לא שובר נעיל.
- כל כתיבה: version, הרשאות manager+ (Field Manager מקומי; שינוי רוחבי → approval לפי RBAC), idempotency-key חובה.
- צורת שגיאה אחידה: 400/403/409/422 כמו שאר v1.

## §22 — External stakeholders (נמענים חיצוניים; G3/G6 = דרישת כוונת-מייסד)
מקור: הגדרת 10.9 18:29 — "מסנכרנת... את כל מחזיקי העניין (מנהלים, עובדים, ספקים ולקוחות/הורים)". ספקים והורים/לקוחות **בתוך הסקופ כדרישת מייסד** (לא שאלה פתוחה). תשלומי SMS/WhatsApp נשארים מדחיינים בהחלטתו מ-11.9 14:06.
```
ExternalParty { id, orgId, kind: 'guardian'|'supplier'|'client', displayName,
  contactRefs: [{ channel: 'in_app'|'whatsapp_stub'|'sms_stub', value }],
  links: [{ entity: 'event'|'task'|'participant', entityId, relation }],
  consent: { status: 'pending'|'granted'|'revoked', at }, createdAt, version }
```
- נמענות: חישוב דומינו מרחיב ל-ExternalParties מקושרים. הודעה: in_app directed פעיל + רישום delivery לערוצי stub עם status='not_sent_transport_deferred'. אין שליחה אמיתית לערוץ חיצוני בלי אישורו — stub מתועד, לא מזויף.
- **G3 (ספק):** מינימום אלפא — ספק מקושר למשימות/אירוע מקבל עדכוני in_app directed; אין login לספק בגרסה זו, אין דף ספק. זה סוגר את "אין משטח בכלל" ברמת המודל והמסירה.
- **G6 (הורה יזום):** מינימום אלפא — `GET /v1/public/status/:accessToken` קריאה-בלבד לאורח: לו״ז + סטטוסים של ה-participant המקושר בלבד. token נוצר ע"י manager, מתבטל ב-revoke. בלי הרשאות חדשות למשתמשים רשומים.
- consent.status='revoked' משתיק כל מסירה לאותו contactRef בכל הערוצים (חובה, נאכף בשכבת ה-dispatcher).
- Actions += stakeholder.create/update/delete/link/read (manager+). Action count 37 → 42. AuditEntityType += 'external_party'. בידוד טננטי מלא.

## §23 — Branches (סניפים)
מקור: הגדרת 10.9 — "ניהול מרכזי של אירועים, סניפים... במטריצה אחת".
```
Branch { id, orgId, name, location?, active, createdAt, version }
Event.branchId?  // additive, nullable
```
- `GET /v1/orgs/:orgId/matrix?from&to` — קריאה בלבד: אירועים/ימים/משימות מקובצים לפי branchId.
- Actions += branch.create/update/archive/read (manager+). Action count 42 → 46. AuditEntityType += 'branch'.
- לא באלפא (מפורש): domino חוצה-סניפים, שיוך צוות לסניף, הרשאות ברמת סניף. היקף הדומינו נשאר פר-אירוע.

## §24 — Field report surface (G1, stop-ship)
דיווח שאינו delay חייב להגיע למנהל — אחרת העובד חוזר לוואטסאפ.
- `GET /v1/reports?eventId=&dayId=&status=&unread=` — manager+/Field Manager ב-scope; מחזיר דיווחים עם read state פר-מנהל. מבטל את התלות ב-reportId שאי אפשר לגלות (resolve נשאר לפי ID, אבל ה-ID ניתן לגילוי מהרשימה).
- Notification job על report מסוג blocked (ועל done: עדכון שקט במשטח, בלי push); blocked מייצר job למנהל האירוע בדומה ל-CR של delay.
- Actions += report.list / report.markRead. Action count 46 → 48. (report.create/resolve קיימים.)

## §25 — Inbound opt-out (G2, stop-ship, רגולטורי)
- `POST /v1/webhooks/inbound` — קלט ספק-ניטרלי { channel, from, body }; מנתב ל-handleInboundStop הקיים. STOP/הסרה בכל נוסח סביר → consent.status='revoked' + audit.
- אכיפה: dispatcher בודק consent לפני כל מסירה חיצונית (כולל stubs — הרישום מסומן 'suppressed_consent_revoked').
- גם כשהתשלומי ערוצים מדחיינים, הנתיב והאכיפה קיימים — consent הוא מצב מערכת, לא תכונת ספק.

## כללים חוצים
- Additive-only; ביטולים רק דרך §18 (ממתין למייסד). כל כתיבה: idempotency-key, version, audit.
- שערי קבלה: E2E פר סעיף (§4 של C-i-C; תרחיש Builder מלא; הרחבת נמענים guardian; matrix; report list+blocked job; STOP מקצה לקצה) + QA labels מחייבות + חמש פסיקות הצירים הבלתי-תלויות.
- ידוע: §17 טרם מיושם ב-backend — דרישת idempotency-key היא קדימה-מבט; שני היישומים באותה ספרינט והשער הקשיח נדלק עם ההטמעה.
