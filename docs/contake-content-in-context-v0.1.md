# Contake — תוכן תפעולי בהקשר (Content-in-Context): מפרט ארכיטקטורה וחוזים v0.1
**תאריך:** 17.9.2026, 02:14 | **מחבר:** Technical Lead | **מקור:** תיקון מייסד מהותי (WhatsApp, 17.9 02:13)
**מעמד:** שינוי ליבה מוצרי. Focus Mode הוא לא מסך משימות — הוא תסריט/סביבת עבודה חיה, תלוית-זמן והקשר. כל מה שעובד שטח צריך כדי *לעשות* את העבודה יכול להיות נוכח ברגע הנכון.
**הכוונת מייסד (02:16):** Content-in-Context הוא דרישת ALPHA מלאה, לא UI בלבד — UX, מודל נתונים, APIs, הרשאות, timing/versioning, דומינו (rescheduling/reassignment), offline/sync, audit, בידוד טננטים ו-QA. אלפא לא מוכנה אם זה קיים רק בעיצוב. היקף אלפא: text, link, checklist, equipment, simple form — E2E ב-Builder וב-Focus. file blobs נשארים חסומים על החלטת storage/Postgres, אבל אסור לזייף אותם כתוכן סטטי במסך. progressive disclosure נשמר: משימה פשוטה נשארת פשוטה.
**זיקוק מייסד (02:15):** היכולת אופציונלית ומדורגת, לא חובה. שלוש רמות משימה: (1) פשוטה — כותרת/זמן/אחראי/פעולת סיום בלבד; (2) מתוגברת — רק המשאבים הנדרשים (קישור/צ'קליסט/ציוד/קובץ/טופס); (3) מודרכת — תסריט מלא/צעדים/טפסים. Domain Profiles *חושפים* סוגי משאבים ותבניות רלוונטיים, *לא דורשים* אותם. העיקרון: כל מה שצריך *יכול* להיות נוכח ברגע הנכון — לא שכל משימה *חייבת* תוכן. Builder ו-Focus נשארים קלים כשאין משאבים: אין chrome של אטאצ'מנטים ריק, אין נטל authoring על משימה פשוטה.

## 1. העיקרון (generic core, לא camps)
משימה אינה שורת זמן+סטטוס. משימה היא צומת עבודה שאליה מחובר **תוכן תפעולי**: הוראות, תסריט פעולה, קבצים, קישורים (כולל YouTube), צ'קליסטים, ציוד נדרש, טפסים. התוכן מועבר לעובד **בחלון הזמן/הקשר שבו הוא רלוונטי** (הכנה, ביצוע, סיום), ולא כאחסון צדדי. שינוי לוז נושא את התוכן איתו אוטומטית.

## 2. מודל (v1.20, additive — TL-owned, יושם אחרי הדמו)
```
ContentItem { id, orgId, kind: 'text'|'link'|'file'|'checklist'|'equipment'|'form',
  title, body?, url?, blobRef?, checklistItems?, meta, createdBy, createdAt, version }
TaskResource { taskId, contentId, role: 'instructions'|'script'|'media'|'checklist'|'equipment'|'form',
  visibleFrom: taskStart - prepOffsetMin,  // ברירת מחדל: פרופיל (קייטנה: 15ד')
  visibleUntil?: taskEnd, ackRequired?: bool }
```
- כללי ברזל: תוכן מקושר ל-taskId, ולכן **נע עם הדומינו בחינם** — הזזת משימה מזיזה את חלון המסירה; לא צריך לוגיקת תוכן נפרדת במנוע. שינוי לוז עם ackRequired מייצר push שמפנה ל-Focus Mode, לא מצרף תוכן ל-push עצמו (פרטיות + גודל).
- Visibility נגזרת מזמן (server-computed), לא מ-state ידני: Focus Mode תמיד שואל "מה עכשיו" והשרת מחזיר צעד + תוכן גלוי.
- רמת המשימה נגזרת (derived), לא שדה: משימה בלי TaskResources = פשוטה; עם 1-2 משאבים = מתוגברת; עם script/checklist/form מובנית = מודרכת. אין flag ידני שיכול לסטות מהמציאות.
- progressive disclosure בחוזה: `GET /v1/focus/now` מחזיר `visibleResources: []` למשימה פשוטה וה-FE לא מרנדר שום chrome של תוכן במקרה זה; Builder מציע צירוף משאב כאפשרות משנית (לא שלב חובה ביצירת משימה).
- אין שכבת program נפרדת: program = event קיים; step = task קיים; Builder = עריכת tasks + TaskResources. לא ממציאים היררכיה חדשה (חוקת הפשטות).
- Actions (matrix v1.6, additive): content.create / content.update / content.delete / content.attach / content.read — manager+ לכתיבה, כל תפקיד משובץ לקריאה ב-scope. AuditEntityType +='content_item'. Action count 32 -> 37.
- endpoint חדש: `GET /v1/focus/now` -> { currentStep, nextStep, visibleResources[], window } per worker. קיים חלקית בפוקוס של היום — הרחבה, לא החלפה.
- קבצים: blobRef לאחסון (free tier: בעיה ידועה — R2/S3 עולה כסף; שלב ראשון: text/link/checklist/equipment/form בלבד, file=external URL בלבד, לא blob אצלנו). **החלטה: בלי file-hosting עד החלטת persistence — אותו fork.**

## 3. זרימות
- **Builder (מנהל):** בניית יום/תוכנית = tasks קיימים + צירוף ContentItems לכל צעד, עם prepOffset פר-צעד או ברירת-פרופיל. עריכת תבנית יום = לשון חוזרת (קשור ל-gap #1 recurrence).
- **Focus (עובד):** צעד נוכחי + תוכנו בזמן אמת. סיפור = text בגוף; סרטון = link שנפתח in-place; צ'קליסט = סימון פריטים (ack פרטני, אופציונלי).
- **שינוי לוז:** הדומינו זז → חלון הזמן של התוכן זז איתו → push לנמענים הרגיל + התוכן מחכה בפוקוס. אין מצב "הודעה על שינוי בלי הגישה לתוכן".

## 4. הוכחה לקנדידייט החי הבא (חובת הדגמה E2E, לא mock נקי)
תרחיש הקבלה: מנהל בונה ב-Builder צעד "מפגש בוקר" עם סיפור (text) + סרטון (link) + צ'קליסט ציוד → מתפרסם → עובד פותח Focus 15 ד' לפני ורואה הכל → המנהל מזיז את הצעד ב-30 ד' → העובד מקבל push, והתוכן מחכה בחלון החדש → ביצוע + ack. אם הקנדידייט לא מוכיח את זה קצה-לקצה, הוא לא מוכיח את התיקון.

## 4ב. מטריצת מלא-מחסנית (Alpha requirement)
| שכבה | מה נדרש |
|---|---|
| Data model | ContentItem + TaskResource (§2); version על ContentItem; ack state פר עובד-צעד |
| APIs | CRUD תוכן, attach/detach, focus/now עם visibleResources; כולל offline queue לסימון checklist/ack (אותו מנגנון reports, עם clientReportId-מקביל) |
| הרשאות | read לפי שיבוץ+תפקיד בלבד; כתיבה manager+; תוכן לא גלוי ללא-משובצים; בידוד טננטי מלא (חוקה §4) |
| Timing/versioning | חלון visibility מ-server; שינוי תוכן אחרי פרסום = version חדש + audit; עובד רואה תמיד את הגרסה העדכנית בחלון |
| דומינו | הזזה/הקדמה: חלון התוכן נע אוטומטית (קישור taskId). Reassignment: ack של עובד קודם מתאפס/מסומן, הנמען החדש מקבל התראה עם התוכן |
| Offline/sync | Focus שומר את הצעד+תוכן האחרון שסונכרן (read cache), acks/checklist בתור; חיבור חוזר = sync מלא |
| Audit | content_item entity; create/update/attach/ack מתועדים |
| QA | §4 תרחיש E2E + בידוד + הרשאות + offline ack + version bump מול עובד מחובר |
| file blobs | חסום על storage/Postgres fork; באלפא file=external URL בלבד. אין placeholder מזויף ב-UX: סוג file לא נחשף ב-Builder עד שהתשתית קיימת |

## 5. השפעות על מסמכים (propagation)
- Architecture: Focus Mode מוגדר מחדש כ-work script; Builder מוגדר כ-authoring של צעדים+משאבים.
- Contracts v1.20: סעיף 20 לפי §2 (אצלי, אחרי הדמו).
- Backlog v0.2: פריט P1 חדש "Content-in-Context" — **דרישת אלפא** (חוסם הגדרת "אלפא מוכנה"); צמוד ל-recurrence (#1) ול-Builder. file-hosting תלוי ב-Postgres/storage fork.
- Design synthesis + Taste Bible (DL): Focus Mode הוא **סביבת עבודה** לא רשימה; Builder הוא מסך עריכה מלא, לא מודאל; התוכן הוא אזרח מחלקה ראשונה בסצנה, לא אטאצ'מנט.
- Execution team: הקנדידייט החי הבא חייב לעבור את תרחיש §4.
- QA: שער E2E חדש לפי §4 + בידוד תוכן בין טננטים + הרשאות read per role + בדיקת משימה פשוטה (אפס chrome תוכן, אפס נטל).
- Design (DL): מבחן קשיח — משימה פשוטה ב-Focus וב-Builder חייבת להראות *זהה* להיום פלוס כלום; chrome של משאבים מופיע רק כשיש משאבים.
