# Contake — מפרט מנוע הדומינו (computeDomino)

גרסה 1.3 | 2026-09-11 | v1.3: QA-M1-1 טריגר נעול נדחה תמיד, QA-M1-2 חלון חוצה-חצות, QA-M1-3 מחיקת משימה published עם מנויים אסורה | Technical Lead. החתימה ב-`contake-core-contracts.v1.ts` היא החוזה; מסמך זה מגדיר את הסמנטיקה.

## 1. עקרונות (נעולים, מהמוצר)

1. המנוע **תמיד מחשב ומציע** — הוא אף פעם לא מחיל בעצמו. ההחלה נובעת מ-impact class × תפקיד (מפת RBAC).
1א. **טריגר נעול נדחה תמיד (QA-M1-1, Sev-1)**: task.move על משימה עם locked=true מחזיר LOCK_VIOLATION blocking לכל תפקיד, כולל admin — אין פטור לטריגר. ה-API דוחה ב-409. הדרך היחידה להזיז משימה נעולה: constraint.unlock (פעולה מפוקחת ברמת propose במטריצה) ואז move. בלי הכלל הזה unlock מאבד משמעות.
2. **אילוץ קשיח (locked) לא זז אוטומטית לעולם.** הצעה שלא ניתנת לפתרון בלי להזיז נעילה = conflict, לא הזזה.
3. דטרמיניסטי וטהור: אותו input → אותו output. בלי שעון, בלי random. הזמן נכנס כפרמטר.
4. איזומורפי: אותה פונקציה רצה בשרת (apply אמיתי) ובדפדפן (תצוגה מקדימה בבונה האירוע) — כמו בפרוטוטיפ v2.
5. **רק מי שהושפע מקבל עדכון** — פלט ה-Impact הוא מקור ה-targeting היחיד להתראות.

## 2. מודל אילוצים

| אילוץ | ייצוג | אכיפה |
|---|---|---|
| תלות finish-start + lag | `DependencyEdge` (DAG, ללא מעגלים — נדחה בכתיבה) | הזזת successor כך ש-start ≥ pred.end + lag |
| נעילה קשיחה | `TaskNode.locked` | אסורה הזזה; הצעה שדורשת → LOCK_VIOLATION |
| משאב בלעדי | `ResourceNode.exclusive` | שתי משימות חופפות על אותו משאב → DOUBLE_BOOKING (blocking) |
| חלון עבודה | `profile.rules.workingWindow` | משימה מחוץ לחלון → WINDOW_VIOLATION (non-blocking אזהרה בלבד). **חוצה-חצות (QA-M1-2)**: ההשוואה על instants עם גלילת תאריך — סוף שעובר חצות נחשב גדול מ-wEnd; משימה 23:30→01:30 חייבת לקבל אזהרה |
| קיבולת | `ResourceNode.capacity` | **RESERVED — לא נאכף ב-Alpha (QA D2)**; השדה נשאר לפוסט-Alpha |
| גבול הזזה | `profile.rules.maxShiftMin` | הזזה מצטברת מעל הגבול → MAX_SHIFT_EXCEEDED |

## 3. האלגוריתם (צעדים חובה)

1. **Validate**: ה-change חוקי? (task קיים, newStart תקין, DAG נשמר אחרי הוספת קשתות).
2. **Apply trigger**: החל את השינוי המבוקש על snapshot זמני. כל חישובי הזמן על instants עם offset (UTC בליבה); working window ו-maxShift מחושבים ב-`EventNode.timezone` (QA C4/AC-GRAPH-5).
3. **Topo-sort** את ה-DAG (Kahn). סדר שוויון: לפי start, אח״כ id — דטרמיניזם.
4. **Propagate**: עבור כל successor, `start = max(start, pred.end + lag)`. חזור עד יציבות (מקסימום n איטרציות — מעגל לא אפשרי אחרי validate).
5. **Locks (מנעול סמנטיקה מלאה, QA D1)**: משימה נעולה שהייתה צריכה לזוז → conflict מסוג LOCK_VIOLATION (blocking). המשימה הנעולה **לא זזה**. כל תלוי שלה שלא ניתן לקיים ביחס לזמן הקיים של הנעילה: נשאר בזמנו הנוכחי, **מופיע ב-`blockedTaskIds`** (לא ב-`movedTasks`), ולא מייצר שום התראה. שאר השרשרת (שאינה תלויה בנעילה) ממשיכה להיזזר כרגיל. proposal עם blocking conflict לא מוחל ולא מעדכן אף נמעד עד שהאדם פותר: unlock / הזזה ידנית / ביטול.
6. **Resources**: אחרי ההתייצבות, בדוק חפיפות על משאבים בלעדיים → DOUBLE_BOOKING.
7. **Impacts**: לכל משימה שזזה ה-start שלה: assignees (אנשי צוות מושפעים), groups (→ בעלי עניין חיצוניים), ו-impact class:
   - S0: רק המשימה עצמה, בלי נמענים חיצוניים
   - S1: משימות נוספות באותו site
   - S2: site אחר או משאב משותף בלעדי
   - S3: קבוצה עם subscriberChannelIds (הורים/לקוחות)
8. **summaryHe (נעוץ, QA golden corpus)**: משפט אחד — ״אפקט דומינו: N משימות תלויות יזוזו (שם הראשונה)״. **N סופר משימות תלויות בלבד, לעולם לא את משימת הטריגר.** תרחיש האוטובוס: טריגר 1 + 5 תלויות → N=5.

## 3א. התנהגות תלוי חסום אחרי נעילה קשיחה (נעוץ, QA)

כשדחיפת דומינו מגיעה למשימה נעולה (locked):
1. הנעולה לא זזה. נקודה.
2. **כל תלוי ישיר** של עוגן (נעילה או MAX_SHIFT): נשאר בזמנו, נרשם ב-`blockedTaskIds`, לא ב-`movedTasks` — בין אם ניתן לקיימו ובין לאו (קורפוס נעוץ). משימות רחוקות יותר ב-downstream מחושבות רגיל מול הזמנים שלא השתנו.
3. blocked tasks **לא** נספרות ב-N של summaryHe ו**לא** מייצרות התראות.
4. נוצר LOCK_VIOLATION עם `blocking: true` → `ok=false` → ההצעה כולה לא מוחלת.
5. יציאה אנושית בלבד: מנהל-על מסיר נעילה / מזיז ידנית / מבטל משימה → recompute.

## 3ב. סמנטיקת ok ו-conflicts

`ok === false` אם ורק אם קיים לפחות conflict אחד עם `blocking: true` (LOCK/DEPENDENCY/DOUBLE_BOOKING/MAX_SHIFT). WINDOW_VIOLATION לבדו משאיר ok=true ומוצג כאזהרה. proposal עם ok=false: לא מוחל, לא שולח התראות, מחזיר conflicts מלאים.

## 3ג. מחיקה מול ביטול (QA-M1-3)

task.delete על משימה **published עם מנויים חיצוניים** (assignee group עם subscriberChannelIds) — אסור: ה-API דוחה 409 TASK_HAS_SUBSCRIBERS והדרך היחידה היא task.update status=cancelled (שמייצר impact עם afterStart:null ומעדכן את המנויים). מחיקת משימת טיוטה או ללא מנויים — מותר. הסיבה: מחיקה לא מייצרת impacts, והורים על פעילות שפורסמה חייבים לשמוע שהיא בוטלה.

## 4. תרחישי בדיקה חובה (QA copy)

1. אוטובוס מאחר 45׳ → 5 פעילויות זזות, נעילות נשמרות, רק 3 מדריכים + 28 הורים מעודכנים (תרחיש הדגל).
2. נעילה באמצע שרשרת → conflict, לא הזזה.
2א. task.move על משימה נעולה (admin + field_manager + S0) → LOCK_VIOLATION/409 תמיד (רגרסיית qa-lock-bypass של QA).
2ב. משימה 23:30→01:30 → WINDOW_VIOLATION.
2ג. מחיקת משימה published עם מנויים → 409; ביטול → impact S3 עם afterStart:null.
3. ציוד בלעדי כפול → DOUBLE_BOOKING אדום.
4. דיווח ״delayed +30׳ מ-Focus Mode על משימה **לא נעולה** עם impact S0 → auto-apply (reportApplyRule). אותו דיווח על משימה נעולה או impact S1+ → ChangeRequest pending_review. כפילות clientReportId → דיווח אחד בלבד.
5. Cross-domain: אותו תרחיש בפרופיל יום צילום (צוות תאורה/מצלמה/לוקיישן) — פלט זהה במבנה, שונה במילון בלבד.
6. שרשרת באורך 20 משימות < 50ms ב-Node 22.

## 5. ממשק ל-Backend

- `POST /v1/domino/compute` — dry-run לכל בעל הרשאה (תצוגה מקדימה).
- mutation שמסווג S1+ → ChangeRequest עם `dominoResult` קפוא. אישור = apply אטומי ב-transaction עם בדיקת `version` (optimistic concurrency); נכשל → 409 + recompute.
- כל apply נכתב ל-`change_log` (לפני/אחרי + ChangeRequest id).
