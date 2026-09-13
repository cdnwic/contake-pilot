# Contake — Web Push (ערוץ משלים in-app)

גרסה 1.0 | 2026-09-12 | Technical Lead. עוגן: החלטת המשתמש (11.9, אושרה ושודרה דרך main) — web push מאושר כערוץ in-app משלים; הכל על התשתית שלנו מלבד תיווך שירות ה-push של הדפדפן/OS. SMS/WhatsApp/Meta נשארים חונים ומכובים — המסמך לא נוגע בהם.

## 1. עיקרון

push הוא **נתיב מסירה נוסף לאותה מטרת ההתראה הקיימת** — לא מקור נמענים חדש. סעיף 2 במפרט ההתראות (v1.6) נשאר פרטי: `DominoResult.impacts` הוא מקור ה-targeting היחיד. push משרת רק נמעדים פנימיים (משתמשי אפליקציה: מנהלים, מנהלי שטח, עובדי קצה). למנויים חיצוניים (הורים/לקוחות) אין אפליקציה ב-Alpha — הם מחוץ לטווח push לחלוטין.

## 2. מודל מנוי (PushSubscription)

מנוי per user/device (endpoint ייחודי לדפדפן+מכשיר), org-scoped. שדות:

```
PushSubscription {
  id, orgId, userId,            // orgId מסונכרן עם ה-Principal — ללא הרשאה צולבת
  endpoint: string (unique),    // סוד תפעולי: מי שמחזיק בו יכול לשלוח. לעולם לא נפלט ב-frames/תשובות למשתמש אחר
  keys: { p256dh, auth },
  deviceClass?: string,         // ua-derived, תצוגה בלבד בהגדרות
  createdAt, lastUsedAt
}
```

- GraphRepository (שני המתאמים, memory + Postgres): `upsertPushSubscription` (idempotent לפי endpoint — רישום חוזר מאותו דפדפן = עדכון keys/lastUsedAt, אין כפילות), `listPushSubscriptions(userId)`, `deletePushSubscription(userId, endpoint)` (מאובטח לבעלים בלבד), `deletePushSubscriptionByEndpoint(endpoint)` (לניקוי dispatcher על 404/410). Postgres: אינדקס ייחודי על endpoint, FK (orgId,userId).
- תוקף: הדפדפן עלול לסובב endpoint — הקליינט מאזין ל-`pushsubscriptionchange` ורושם מחדש. מנוי מת מנוקה בשרת (סעיף 6), לא לפי שעון.

## 3. נתיב שליחה — שילוב ב-dispatch הקיים

ללא שינוי ב-buildJobs* וב-NotificationJob. ה-dispatcher מרחיב את נתיב ה-`in_app`:

- לכל target עם `channel='in_app'` (address = userId) — מלבד מסירת ה-Socket.IO — נשלח push לכל מנוי פעיל של אותו userId. אין מנויים → no-op (in_app כבר נמסר).
- **מחלקת נמעד (QA-M2-2, ללא שינוי)**: push עובר רק לנמעדים פנימיים → **לעולם לא מעוכב בשעות שקט**. ה-holdUntil הקיים חל רק על jobs חיצוניים, ש-push לא נוגע בהם.
- **איגוד 60 שניות (ND-3)**: חל על push כמו על ערוץ ספק — חלון per userId. שינוי שני+ בחלון = push אחד מסוג `digest_multi_change` (אותה תבנית, אותם params). אין פיצוץ push-ים.
- **אידמפוטנציה**: מפתח DispatchRecord קיים (`idempotencyKey|address`) מורחב עם סיומת ערוץ ל-push: `...|push:{userId}` — retry של enqueue לא משכפל שליחה, והספירה מול ה-in_app לא מתנגשת.
- **ממשק ספק** (בדפוס MessageProvider): `WebPushProvider { send(subscription, payload): Promise<ProviderResult> }`. ברירת מחדל log-only sandbox; המימוש האמיתי (`web-push`, VAPID) נדלק רק כשמפתחות ב-env. ProviderResult.retryable: 404/410 = **לא-retryable** (מנוי מת — מחיקה מיידית); 429/5xx = retryable עם כיבוד Retry-After (מדיניות backoff הקיימת, x3); קוד לא-מוכר = **לא-retryable** (סמנטיקת v1.6 — כפילות גרועה מכישלון קולי).

## 4. מטען (payload)

```json
{ "title": "<event.name>", "body": "<תבנית מעובדת, params allowlist בלבד>",
  "icon": "/icons/push-192.png", "badge": "/icons/badge-96.png",
  "data": { "url": "<deep link>", "jobId": "<NotificationJob.id>", "kind": "<NotificationKind|digest_multi_change>" } }
```

- title = שם האירוע (זמין מה-job, דטרמיניסטי, ללא שינוי פרופיל). body = renderTemplate הקיים — אותם allowlists, אין interpolation חופשי.
- deep link (כלל קבוע, אותו מיפוי של dispatcher ההתראות האינטראקטיבי, PR-3): `change_needs_approval` → Control Tower notification center על ה-CR; `task_assigned`/`task_moved`/`task_cancelled` לעובד קצה → Focus על המשימה; אחרת → מרכז ההתראות. הקליק פותח/ממקד את ה-PWA ומנווט; ה-state מגיע דרך resync גרסתי רגיל (RT-PIN-3/5), לא מתוך ה-payload.
- ה-payload נושא שמות משימות/אירוע בלבד — כמו ההתראה המקבילה ב-in_app. אין בו subscriber channels, endpoints או נתוני משתמשים אחרים (QA-M2-3 analog).

## 5. זרימת הרשאה (FE)

- **אחרי login ראשון מוצלח** (שני היישומים): כרטיס הסבר in-app קצר בעברית ("קבל עדכונים גם כשהאפליקציה סגורה") עם כפתור הפעלה — רק אז `Notification.requestPermission()`. לעולם לא prompt של דפדפן בלי הקשר מקדים.
- מצבים: granted → רישום מנוי בשרת; denied → הכרטיס מוצג כ"חסום בדפדפן" עם הוראת שחור קצרה, ללא לחץ חוזר; dismiss → לא מציקים שוב באותו session, חוזר ב-login הבא (לכל היותר פעם ליום).
- **הגדרות**: toggle "התראות push" — ON יוצר/מרענן מנוי, OFF קורא `subscription.unsubscribe()` + DELETE לשרת. רשימת מכשירים רשומים (deviceClass + createdAt) עם כפתור הסרה per device. ה-toggle משקף את מצב הרשאת הדפדפן בפועל (כולל כיבוי מה-OS), לא נועל על ערך שמור.
- **Service worker**: Focus Mode כבר PWA — מוסיפים handler ל-`push`/`notificationclick`. Control Tower רושם SW מינימלי ל-push בלבד (דרישת PushManager). שניהם מאזינים ל-`pushsubscriptionchange` → רישום מחדש שקט.

## 6. unsubscribe / תפוגה

- כיבוי מההגדרות / `unsubscribe()` בדפדפן / אובדן הרשאה → DELETE לשרת. תפוגה אמיתית מזוהה בשרת בלבד: 404/410 מהספק → מחיקת המנוי מיידית (לא retry, לא השבתה-זמנית). dispatch הבא למשתמש פשוט מדלג על push.
- אין ניקוי מוני מתוזמן ב-Alpha; ה-410 הוא ה-orphan collector.

## 7. API וחוזים (מועמד v1.10 — אדיטיבי בלבד, ממתין לאישור)

- `GET  /v1/push/vapid-public-key` → `{ publicKey }` (מאומת, כל תפקיד; המפתח הציבורי אינו סוד).
- `POST /v1/push/subscriptions` { endpoint, keys } → upsert לבעלים בלבד.
- `GET  /v1/push/subscriptions` → רשימת המנויים של המשתמש המחובר בלבד (ללא endpoint מלא בתשובות? **כן מלא** — הבעלים רשאי; לעולם לא של משתמש אחר).
- `DELETE /v1/push/subscriptions` { endpoint } → בעלים בלבד; endpoint של משתמש אחר → 403.
- אימות: שלושת המוטטיבים הם self-service מחוץ למטריצת ה-22 (כמו auth/OTP) — **אין שורת matrix**. קריסת userId מנוי = הפרת scope → 403 + שורת audit `outcome='denied'` (v1.9). כל mutation מצליח נרשם ב-audit (QA §9) עם `Action` חדשים `'push.subscribe'/'push.unsubscribe'`, `AuditEntityType` חדש `'push_subscription'`.
- `NotifyChannel` מקבל `'web_push'` (אדיטיבי; כיום נמעדים לא נושאים אותו — הערוץ נגזר ב-dispatch, והאיחוד משקף את מרחב הערוצים). **אין** שינוי ב-NotificationJob, RealtimeFrame, מטריצת RBAC, פרופילים, תבניות.
- Rate limiting על POST/DELETE (כמו endpoints רגישים אחרים). סודות: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` ב-env בלבד (סריקת סודות ב-CI קיימת); בלעדיהם הספק log-only.

## 8. קריטריוני קבלה מוצעים ל-QA

- AC-PUSH-1: רישום idempotent — POST כפול לאותו endpoint = מנוי אחד, ללא שגיאה.
- AC-PUSH-2: שליחה לשני מכשירים של אותו משתמש; שני משתמשים באותו org לא מקבלים זה של זה; org אחר — דממה.
- AC-PUSH-3: איגוד — 3 שינויים ב-30 שנ׳ לאותו משתמש = push digest אחד (`digest_multi_change`).
- AC-PUSH-4: שעות שקט — push פנימי יוצא ב-23:55 (אין hold); job חיצוני מעוכב לא מייצר push כלל.
- AC-PUSH-5: ספק מחזיר 410 → המנוי נמחק, הדיווח הבא לא מנסה אותו; 429 מכובד Retry-After; קוד לא-מוכר = לא-retryable.
- AC-PUSH-6: דליפה — שום frame/תשובה ל-field_manager/focus_worker לא נושא endpoint/keys של אחר (סריקת e2e כמו QA-M2-3).
- AC-PUSH-7: authz — ניסיון subscribe/delete למשתמש אחר → 403 + audit denied; 401 בלי auth ללא שורה.
- AC-PUSH-8: כשל push אינו מייצר `notify.failed` כשה-in_app נמסר (הוא נרשם ב-DispatchRecord בלבד) — אין רעש למנהלים על מכשיר בודד.

## 9. חלוקה והערכה

- **Backend** (~0.5 יום): שדות/מתאמי repo, 4 routes, הרחבת dispatcher + WebPushProvider (sandbox + VAPID), בדיקות יחידה לסעיפים 3/6.
- **Frontend** (~0.5–1 יום, במקביל): SW, כרטיס הרשאה, toggle+מכשירים בהגדרות, deep-link click handling, RTL.
- **TL (אני)**: contracts v1.10 אחרי אישור ההורה ל-diff; **QA**: AC-PUSH-1..8 + רגרסיית 469.
- תלות חיצונית יחידה: יצירת מפתחות VAPID (npx web-push generate-vapid-keys) בפריסה — עלות אפס, בלי חשבון חיצוני.
