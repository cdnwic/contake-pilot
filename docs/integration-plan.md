# Contake Alpha — תוכנית אינטגרציה ורצף עבודה

גרסה 1.0 | 2026-09-11 | Technical Lead. תואם את ההערכה שסופקה לחיים: 6–10 שבועות, כיוון 8; גרסה ריצה ראשונה תוך 2–3 שבועות.

## 1. מפת זרימות עבודה (5 סוכנים)

| סוכן | בעלות | ממשקים נכנסים |
|---|---|---|
| Technical Lead (אני) | ארכיטקטורה, contracts, אינטגרציה | — |
| Backend | apps/api, domino server-side, RBAC hooks, notifications worker | contracts.v1, domino spec, RBAC spec |
| Frontend | Control Tower + Focus Mode | contracts.v1, design tokens מסוכן העיצוב |
| Design | מערכת רכיבים + @contake/ui, חוקר כיוון ויזואלי | הפרוטוטיפ v2 כבסיס ראשוני בלבד |
| QA/Security | תוכנית בדיקות עצמאית, e2e, threat model | כל המסמכים; לא מאשר ״נראה עובד״ |

## 2. לוח זמנים

| שבוע | תוכן | אבן דרך |
|---|---|---|
| 1 | חוזים נעולים (contracts.v1 ✔), skeleton monorepo, seed, בדיקות בסיס | contracts frozen |
| 2–3 | Backend: graph CRUD + auth + computeDomino מול in-memory. Frontend: Control Tower על API אמיתי. Design: כיוון ויזואלי ראשון | **M1 — גרסה ריצה ראשונה**: קייטנה אחת, מקצה לקצה, בלי התראות חיצוניות |
| 4–5 | domino.apply + ChangeRequests + RBAC מלא, change_log. Focus Mode PWA + דיווחים | **M2 — דומינו מלא עם אישורים** |
| 6–7 | Design system מיושם, פרופילים: הפקה + יום צילום. BSP ל-WhatsApp נבחר ותבניות מוגשות | **M3a** |
| 7–9 | כל 6 הפרופילים, התראות sandbox מקצה לקצה, digest/שעות שקט | **M3 — רב-ורטיקלי מלא** |
| 10 | QA e2e מלא, threat model, תיקונים, סביבת demo יציבה | **M4 — Alpha להדגמה** |

## 2א. מיפוי לשערי QA (G0–G4)

ה-QA Charter (v1.0, 2026-09-11) מחייב ומאומץ כאילוץ: G0 בסוף שבוע 1 (חוזים + infra + fixtures לכל הפרופילים + golden corpus כטסטים רצים); G1 ≈ M1; G2 ≈ M2 (מטריצת RBAC כטסטים מ-machine-readable matrix, בידוד, recovery, audit, אבטחה); G3 ≈ M3 (התראות staging, 5 פרופילים על אותה סוויטת מנוע, נגישות, ביצועים); G4 = M4. שום build לא נקרא ״מוכן״ בלי מעבר שער בכתב מה-QA. אין לחץ deadline שעוקף שער.

## 3. כללי אינטגרציה

1. **חוזה לפני קוד**: אף סוכן לא מממש מול שריר הדמיון — רק מול contracts.v{N}. פער מהחוזה → מדווח לי, לא ״מתקן בשקט״.
2. **גרסאות contracts**: שינוי שובר = bump גרסה + הודעה לכל הסוכנים דרך ההורה, עם migration note ו-`manifest.sha256` לכל drop (QA A2). סוכן ה-Backend מוסר tarball monorepo + manifest בכל milestone ובסוף כל שבוע.
3. **Definition of Done לכל מסירה**: vitest ירוק, טיפוסים הידוק מלא (strict), תרחיש בדיקה רלוונטי מה-spec, צילום מסך לכל שינוי UI.
4. **QA עצמאי**: מריץ את תרחישי החובה על ה-build המשולב בלבד. מקבל לביקורת לפני נעילה: חוזי API + מודל נתונים (הגרסה המצורפת היא *מוצעת*, לא נעולה, עד ביקורת G0), מנוע, design system, תבניות התראות. contracts.v1, rbac-matrix.v1.json ו-domain-profiles.v1.json מופנים ל-QA עם הדו״ח הזה.
5. **Demo בכל milestone**: הורה מקבל קישור/צילומים + מצב מול התוכנית. חיים נפגש רק אם יש החלטה מהותית או חסם.

## 3א. קריטריוני קבלה מצטברים (M2.1+)

- QA-M2-1: בדיקת איגוד חוצת-ticks (5 שינויים ב-30שנ׳ לנמעד אחד → הודעה אחת).
- QA-M2-2: בדיקת פיצול hold: נמעד צוות מקבל מיידי ב-23:55 בעוד נמעד חיצוני נעצר ל-07:00, באותו שינוי.
- QA-M2-3 (אבטחה): frames של site ב-realtime **לא נושאים subscriberChannelIds** (ולא כל שדה של ערוצי מנויים); בדיקת דליפה ב-e2e. כלל קבוע: כל frame/תשובה ל-field_manager/focus_worker עובר סינון מנויים, בדומה ל-filteredGraph.
- ~~QA-M2-4~~ (מפוצל ל-5+6, מיספור QA הרשמי):
- QA-M2-5: כשלון טרמינלי ב-dispatch חייב להירשם ב-audit ולהופיע ב-Control Tower (notify.failed). אין התראה שנופלת בשקט.
- QA-M2-6 (אטומיות): כשלון **כתיבת audit** מבטל את ה-mutation כולו (rollback) — אסור מצב של mutation שהוחל מאחורי 500. apply+audit באותה יחידה אטומית.
- QA-M2-7 (Sev-2): DELETE /v1/events/:id היה no-op שהחזיר הצלחה מדומה. כל endpoint חייב לבצע את הפעולה בפועל או להחזיר שגיאה; בדיקת עקיפה לכל endpoint: שליחה → שינוי מדד במצב או 4xx/5xx.
- כל M2.1 נכנס ל-G2 רק עם הרגרסיות של QA על סעיפים 1–3 ו-5–7.

## 3ב. קריטריוני קבלה — M3

- ספק: Twilio sandbox ל-WhatsApp+SMS (ספק יחיד מאחורי MessageProvider הקיים; החלטת Tech Lead, עלות אפסה ב-sandbox). אישור תבניות Meta אמיתי = נושא פיילוט, דורש ישות עסקית של חיים — מבוטל לשלב זה, ייפתח איתו לפני פיילוט.
- פרופילים: כל 6 הפרופילים עוברים את אותה סוויטת מנוע (קיים ב-core) + e2e אחד לכל פרופיל דרך ה-API.
- Focus Mode offline: דיווחים בתור מקומי, סנכרון בסדר, exactly-once על clientReportId, חותמת זמן מקורית נשמרת (AC-FR-2). בדיקת airplane-mode.
- ספק fault-injection: נפילת WhatsApp → SMS fallback; נפילה מלאה → תור+retry, כשלון טרמינלי ב-audit וב-Control Tower (QA-M2-5 מכוסה, נבדק מול ספק אמיתי-sandbox).
- Realtime consumption ב-Frontend + design closeout = שארית G3 היחידה (QA).
- RT-PIN-1 (נעוץ): כל נתיב שיוצר ChangeRequest חייב לשדר change.pending + לרשום job של change_needs_approval (כולל דיווח שטח מסלים — תיקון backend, רגרסיה ב-checkpoint הבא).
- RT-PIN-2 (client): Socket.IO מתחבר ל-base URL מוגדר של ה-API (לא origin של הדף), מציג מצב ניתוק למשתמש, ו-reconnect מפעיל invalidation + resync מלא — הקליינט לא מניח שה frames שהחמיץ לא קיימים.
- RT-PIN-3 (client, M3-QA-5): graph.patch אינקרמנטלי מוחל רק אם רצף ה-version עקבי; פער או version ישן → resync מלא. אף frame לא מוחל "על סמך אמון".
- RT-PIN-4 (contracts v1.4): הסרות (ביטול שיבוץ, העברת אתר) נושאות frame מסוג 'graph.remove' {eventId, version, taskIds} לחדרים שהחזיקו את המשימה (חדר האתר המקורי + חדרי user של מי ששובטו מתוך), באותו רצף version של graph.patch. Frames אינקרמנטליים הם upsert-never-delete; הסרה מתיישבת רק דרך tombstone או resync מלא. פריים ההתראה task_unassigned נשאר בצינור dispatch בלבד — הוא לא מנגנון state. (QA אישר את הבחירה והצורה.)
- החלטת משתמש (חיים, 11.9.2026, WhatsApp, בבירור דרך main): **הפיילוט רץ כולו על התשתית שלנו.** משטח ההתראות של הפיילוט הוא האפליקציה עצמה (Control Tower / Focus realtime) — לא ערוצים חיצוניים. ערוצי WhatsApp/SMS נבנים כבסיס בלבד (PR-2: מתאם מאחורי ממשק הספק, מול sandbox) וחונים מאחורי env-gate כבוי לצמיתות עד שהמשתמש יבקש אחרת. עבודת Meta (ישות עסקית/תבניות), רישום זהות שולח SMS, אישור שעות שקט, ורמת opt-out — כולם נדחים ללא תזמון; לא לתזמן ולא להציע מחדש. ההשלכה על הבדיקות: כל מה ש-QA אימת בשעות שקט/batching נשאר נכון כקוד, אבל אין dispatch חיצוני בפיילוט.
- כיוון מוצר נעוץ (חיים, 11.9.2026, WhatsApp): משטח ההתראות באפליקציה חייב להיות **יפה ואינטראקטיבי** — עדכון שמגיע ניתן לטיפול ישירות מתוך ההתראה עצמה (פעולות inline: אישור/דחייה של CR, צפייה בגרף, פתיחת Focus על המשימה), לא רק צפייה. זו דרישת קבלה לפיילוט, לא nice-to-have. אופציה שבוטלה אוטומטית אם לא תאושר: web push דרך שירות הדפדפן/OS — חינם אבל לא 100% ״חונה אצלנו״; נבנה רק אם חיים מאשר במפורש. ברירת מחדל: in-app בלבד.
- החלטת משתמש (חיים, 11.9.2026, WhatsApp): **web push מאושר** (״אין בעיה התראות״) — תוספת scoped באותה משמעת foundation: נבנה כערוץ in-app משלים, הכל בתשתית שלנו מלבד תיווך שירות ה-push של הדפדפן/OS (המשתמש אישר את החריג במפורש).
- PARKED (authz/audit, אופציה שהודחה כרגע): שורת matrix מפורשת ל-'notify.ack' + audit לניסיונות ack שנדחו. QA החליט בגמר: contracts v1.8 נעוץ בלי שורת matrix (admin-only קשיח) ובלי audit לדחיות — audit לדרך ההצלחה בלבד. ההסתייגות מתועדת אצל QA: אם תפקיד נוסף יצטרך ack, השורה תתווסף אז, ובדיקת admin-only קשיחה לא תהפוך לתבנית. שאלת audit-דחיות הכללי מועברת לשער האבטחה של G4.
- עמדת QA נעוצה ל-G4 (שער אבטחה): audit לניסיונות נדחים בכל ה-endpoints המוטטיבים (auth עבר, authz נכשל ← שורת audit עם outcome=denied + סיבה). endpoints של קריאה פטורים מטעמי נפח. החלטה סופית בתכנון G4.
- PARKED (אישור חיצוני עתידי, לצד תבניות Meta): Google Play — חשבון developer + review גוגל נדרשים רק אם/כשנארוז אפליקציה נייטיב. האפליקציה הנוכחית רצה בדפדפן — אין צורך באישור חנות עכשיו. לא לתזמן.
- PARKED (post-Alpha): מוטציית העברת אתר (site-transfer). אין בחוזה היום מוטציה שמשנה siteId, והיא לא בזרימת הפיילוט (מנהל מוחק ויוצר מחדש). מכונת ה-tombstone קיימת ומכוסה דרך נתיב המחיקה; כשהמוטציה תתווסף בעתיד, היא תפליט tombstone לחדר האתר המקורי + חדרי user, ו-upsert patch לחדר היעד — באותו רצף version. צורת ה-frame קפואה (v1.5), כך שהוספת המוטציה לא תשנה consumer.
- RT-PIN-5 (client, QA-M35-1, Sev-2): כל frame נכנס (patch או remove) נבדק מול eventId של הגרף המוצג **לפני** decidePatchAction; frame של אירוע אחר נזרק. חדרים הם ברמת-org, version הוא פר-אירוע — בלי המשמר, frame של e2 מחליף בשקט את התצוגה של e1.
- סודות: מפתחות ספק ב-env בלבד, אסור ב-repo; בדיקת סריקת סודות ב-CI.

## 3ה. PR-3 — משטח התראות אינטראקטיבי (FE, מסלול פיילוט)

מקור: כיוון מוצר נעוץ של חיים (11.9) — ההתראה היא נקודת פעולה, לא תצוגה. Sequencing: מתחיל רק אחרי ש-PR-1/PR-2 נחתכו (קיבולת backend ל-Postgres קודם).

**מנגנון**: מרכז התראות in-app + action dispatcher יחיד בצד לקוח שממפה סוג התראה ← קריאת mutation API קיימת. אין endpoints חדשים. פעולות: approve/decline ל-CR (change.approve / change.decline), jump-to-graph (Control Tower על אירוע/אתר), open-Focus-on-task (deep link למשימה).

**כללי state**:
- הפעולה ננעלת מיד (spinner), ללא double-submit — idempotency key בצד לקוח; לחיצה שנייה = no-op.
- הצלחה: toast אישור + ההתראה מסומנת כמטופלת; ה-frame change.resolved מיישב סופית. כישלון (409 כבר טופל / רשת): חזרה למצב + toast שגיאה; אם ה-CR עדיין pending נשאר ניתן לפעולה.
- change.resolved שמגיע ממנהל אחר לפני הפעולה ← כפתורים ננעלים בתוך frame אחד, עם מי שטיפל.
- אין שום mutation מקומי של הגרף מה-dispatcher — כל state דרך frames בלבד (אין dual-write).

**קריטריוני קבלה ל-QA (G4-FE)**:
- AC-PR3-1: התראת CR מציגה approve/decline inline; approve קורא ל-API, UI ננעל, change.resolved מיישב — בלי רענון.
- AC-PR3-2: double-click מהיר לא מייצר שתי קריאות (נבדק ברשת).
- AC-PR3-3: 409 / ניתוק רשת ← revert + toast שגיאה; CR שעדיין pending נשאר פעיל.
- AC-PR3-4: change.resolved של מנהל אחר נועל כפתורים תוך frame אחד + מציג מי טיפל.
- AC-PR3-5: deep links (גרף / Focus) נוחתים על אירוע/אתר/משימה נכונים עם resync גרסתי — לא תצוגה stale.
- AC-PR3-6: probe של QA: state הגרף זהה ל-refetch טרי אחרי כל פעולת התראה (אין dual-write).
- AC-PR3-7: תצוגת RTL נקייה, תור toast מקסימום 3, auto-dismiss.

## 3ו. G4 — שער עומס ואבטחה (תכנון)

**א. הכללת audit-דחיות (contracts v1.9, אומץ)**: כל ניסיון מוטציה שעבר auth ונכשל ב-authz ← שורת audit עם outcome='denied' + denialReason (matrix_deny / scope_violation). קריאות ו-dry-run פטורים. אין שינוי תאי matrix — denyByDefault הוא מקור האכיפה, v1.9 מוסיף את חובת התיעוד.

**ב. מבחן עומס** (משוקלל לפי החלטת המשתמש — in-app, לא ספקים חיצוניים): (1) socket fanout — שינוי יחיד לאירוע עם מאות מנויים מחוברים (adminsRoom + site rooms + user rooms): latency של frame מקצה לקצה, אובדן 0; (2) task.move בו-זמניים על אותו אירוע תחת lock contention — ניצחון CAS נקי, רצף version ללא פערים; (3) burst של שינויים בתוך חלון ה-60שנ׳ — digest אחד לנמעד, אין פיצוץ הודעות; (4) reconnect המוני (thundering herd) — full resync מבוקר, לא מפיל את השרת. PG mode בלבד (זה הייצור).

**ג. מבחן אבטחה**: (1) מטריצת RBAC נאכפת על כל endpoint — סריקה שיטתית, לא רק הנתיבים שנבדקו; (2) audit-דחיות: ניסיון נדחה מטפקס ← שורת denied עם סיבה; 401 בלי auth ← ללא שורה (אין Principal); (3) injection בשדות טקסט חופשי בעברית (summaryHe, שמות, reasonHe) — stored XSS ב-FE, SQLi ב-PG adapter; (4) socket auth: join לחדר של org אחר / user room זר ← שתיקה מלאה; (5) idempotency תחת replay — אותה בקשה פעמיים לא מייצרת שתי מוטציות/הודעות.

**ד. קריטריון מעבר**: סוויטה מלאה ירוקה בשני המצבים ×5 רצופים (הדטרמיניזם שתוקן ב-ND-3), כל פרובות העומס/אבטחה ירוקות, אפס ממצאים פתוחים Sev-2+.

## 4. סיכונים ומעקב

| סיכון | מיטיגציה |
|---|---|
| אישור תבניות WhatsApp אצל Meta נמשך | הגשה בשבוע 6–7; SMS fallback מוכן מראש |
| פיצול קוד בין פרופילים | כלל ברזל: שינוי פרופיל = JSON בלבד; code review שלי על כל PR ל-core |
| Focus Worker ללא אימייל | OTP ב-SMS/WhatsApp — כבר בחוזה |
| סוכנים דורסים אחד את השני בלי git משותף | בעלות קבצים מפורשת לפי טבלת הזרימות; core אצלי בלבד |
| חיבור GitHub של חיים בעתיד | שאלה אחת ב-M1; המבנה מוכן ל-push כפי שהוא |

## מנגנון (נעוץ)

- push הוא נתיב מסירה נוסף על targeting קיים בלבד. `DominoResult.impacts` נשאר מקור הנמענים היחיד (מפרט התראות §2); **אין** targets חדשים ב-jobs, **אין** שינוי ב-buildJobs*, NotificationJob, frames או תבניות.
- ה-dispatcher מרחיב את נתיב `in_app`: לכל target פנימי, שליחה לכל מנויי ה-push הפעילים של אותו userId מאחורי `WebPushProvider` (sandbox log-only כברירת מחדל; `web-push`/VAPID אמיתי מאחורי env keys בלבד).
- מחלקת נמעד נשמרת: push הוא פנימי-בלבד → לעולם לא מעוכב בשעות שקט; jobs חיצוניים מעוכבים לא מייצרים push כלל (הורים/לקוחות = מחוץ לטווח).
- איגוד 60שנ׳ per userId חל על push (ND-3): שינוי שני+ בחלון = push `digest_multi_change` אחד. אידמפוטנציה ברמת `idempotencyKey|push:{userId}`.
- סמנטיקת כשל (מיושרת v1.6): 404/410 = מנוי מת → מחיקה מיידית, לא-retryable; 429/5xx retryable עם Retry-After; קוד לא-מוכר = לא-retryable. כשל push על מכשיר בודד לא מייצר `notify.failed` כשה-in_app נמסר (רישום ב-DispatchRecord בלבד).
- FE: כרטיס הסבר in-app לפני `Notification.requestPermission()` (אחרי login), toggle + ניהול מכשירים בהגדרות, SW ל-push בשני היישומים, `pushsubscriptionchange` → רישום מחדש שקט, deep links לפי מיפוי dispatcher ההתראות (PR-3), state דרך resync בלבד (RT-PIN-3/5).

## Sequencing

מתחיל מיד, במקביל לסגירת pilot-prep. Backend (~0.5 יום) ו-Frontend (~0.5–1 יום) מקבילים; ממשק ה-ch חוזים הוא v1.10 בלבד. QA: AC-PUSH-1..8 (במפרט) + רגרסיית 469 בשני המצבים. תלות חיצונית יחידה: מפתחות VAPID בפריסה (עלות אפס, בלי חשבון).

## קריטריון מעבר (G5)

כל AC-PUSH ירוקים, רגרסיה מלאה ירוקה בשני המצבים, אפס ממצאים Sev-2+ (בדגש: דליפת endpoints/keys, authz צולב + audit-denied, איגוד ושעות שקט).

## מה נשאר לפיילוט מעבר ל-web push

1. **פריסת סביבת פיילוט** (Render/Fly לפי ארכיטקטורה §2/§6): PG mode בלבד, `DATABASE_URL`, `CONTAKE_DEV_OTP=false` (חובה לפי pilot-auth #3), מפתחות VAPID, seed דמו. ~0.5 יום.
2. **דאטה דמו/פיילוט**: תרחיש האוטובוס המאחר + נתוני קייטנה ריאליסטיים לשני היישומים, יומן אירוע published פעיל. ~0.25–0.5 יום.
3. **מדריך מפעיל בעברית**: מנהל (Control Tower + מרכז התראות אינטראקטיבי) ועובד קצה (Focus + OTP + push). ~0.25 יום.
4. **בדיקת מכשיר אמיתי אחת לפני פיילוט**: PWA על מכשיר חלש, תור offline, push על דפדפן נייד (Chrome/Android ודף בית iOS 16.4+ כמגבלה ידועה — Safari iOS push רק מ-PWA מותקן; נתעד במדריך).
5. **פתוח אצל חיים (לא חוסם)**: גיוס מפעיל קייטנה לפיילוט; החלטות הערוצים החיצוניים חונות כמתוכנן ולא מתוזמנות מחדש.
