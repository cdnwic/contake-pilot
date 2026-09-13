# Contake Alpha — ארכיטקטורת מערכת ואסטרטגיית Repository

גרסה: 1.1 | תאריך: 2026-09-11 | v1.1: A1 stack יושרה ל-Fastify בלבד, A2 שמירת קוד + מניפסט SHA-256 | בעלים: Technical Lead (צוות Alpha)
סטטוס: מסמך סמכותי לבנייה. שינוי מהותי דורש אישור Product Owner (חיים) רק אם הוא משנה היקף, עלות חיצונית או לוח זמנים.

## 1. מטרה וגבולות

בניית גרסת Alpha ריצה של Contake: ליבה גנרית אחת + Domain Profiles, בלי פיצול קוד בין ורטיקלים. ה-Alpha צריכה לתמוך מקצה לקצה בזרימה המרכזית: בניית אירוע → דיווח שטח → מנוע דומינו → אישור שינוי → עדכון ממוקד לבעלי עניין.

לא מטרות ה-Alpha (Non-goals): ריבוי דיירים מסחרי מלא, תשלומים, רישום לקייטנות, אינטגרציות ERP, SLA של Production. אלה נכנסים אחרי פיילוט.

## 2. החלטות Stack (נעולות ל-Alpha)

| שכבה | בחירה | נימוק |
|---|---|---|
| שפה | TypeScript 5.x מקצה לקצה | שיתוף טיפוסים בין מנוע הדומינו, ה-API והקליינטים; סוכני קוד מייצרים TS אמין |
| Monorepo | pnpm workspaces + Turborepo | בילדים מדורגים, cache, הפרדה נקייה בין חבילות |
| Backend | Node 22 + Fastify 5 + vitest (ננעל: סוכן ה-Backend כבר התחיל עליו) | מבנה מודולרי כפוי דרך plugins: routes/ per domain, preHandler hooks ל-RBAC, DI ידני דרך repository interface. In-memory repo ראשון, Prisma/Postgres מאחורי אותו interface |
| DB | PostgreSQL 16 + Prisma, מאחורי `GraphRepository` interface (in-memory impl ב-M1) | החלפת מימוש בלי לגעת בלוגיקה; גרף יחסים ב-SQL רגיל מספיק בסקייל של Alpha |
| תורים/Cache | Redis 7 + BullMQ | עיבוד אסינכרוני של דומינו ושליחת התראות עם retry ו-idempotency |
| Realtime | Socket.IO (WebSocket) | rooms לפי event/scope; fallback ל-polling אוטומטי |
| Control Tower | React 18 + Vite + TanStack Query + Zustand | RTL-first, עברית מלאה, real-time |
| Focus Mode | אותו React codebase, אפליקציית Vite נפרדת + PWA (vite-plugin-pwa) | בלי התקנה, עובד חלש במכשיר, offline queue לדיווחים |
| Validation | Zod בחבילת core משותפת | חוזה אחד: אותו schema בשרת, בקליינט ובטסטים |
| Auth | JWT (access 15ד׳ + refresh) + OTP ב-SMS/WhatsApp לעובדי קצה | עובד שטח לא פותח חשבון עם סיסמה; מנהלים עם אימייל+סיסמה |
| תשתית Alpha | Docker Compose (dev) → Render/Fly.io (staging+demo) | זול, מהיר להקמה; מעבר ל-AWS רק לפני Production |
| CI | GitHub Actions: lint → typecheck → unit (Vitest) → e2e (Playwright) → build | כל PR ירוק לפני merge; אין merge ידני ל-main בלי CI |

## 2א. אסטרטגיית Repository (החלטה, 2026-09-11)

אין חשבון GitHub מחובר וחיבור כזה דורש פנייה לחיים — נמנע. לכן:

1. **Monorepo יחיד קנוני** (git מקומי) מתארח אצל סוכן ה-Backend — הוא בעל `apps/api` ומארח את כלל ה-tree.
2. **packages/core בבעלות Technical Lead (אני)** — מופץ כ-drop-in (`contake-core-contracts.v{N}.ts`) לכל סוכן דרך ההורה. צרכנים נועלים גרסה, אסור לערוך מקומית; שינוי חוזה רק דרכי, עם bump לגרסה ורשומת שינויים.
3. **שמירת קוד (QA A2)**: בכל milestone ובסוף כל שבוע עבודה, סוכן ה-Backend מוסר **tarball של כל ה-monorepo** כ-attachment להורה, עם `manifest.sha256` (sha256 לכל קובץ). כל הפצת contracts נושאת אותו מניפסט — צרכן משווה hash לפני pin. אובדן sandbox ≠ אובדן קוד: הסנאפשוט האחרון אצל ההורה.
4. **הפצה בין סוכנים**: קבצים דרך ההורה בכל milestone (M1–M4). קצוות ה-integration מוגדרים בחוזים, לא בקוד משותף נרחב — כל סוכן מממש מול contracts.v1.1 ומדווח פערים.
5. **CI מקומי**: כל סוכן מריץ `vitest run` (+ Playwright ל-Frontend) לפני כל מסירה; QA מריץ את אותה חבילת בדיקות באופן עצמאי.
6. **פתוח לחיים (לא חוסם)**: בנקודת M1 לשאול אותו אם הוא רוצה שהקוד יעבור ל-GitHub בבעלותו — זה ה-IP שלו כ-Product Owner. שורה אחת, מול אבן דרך, לא עכשיו.

## 3. מבנה ה-Monorepo

```
contake/
  apps/
    api/                 # Fastify 5 (Node 22) — הליבה השרתית
    control-tower/       # React — דשבורד מנהלים (דסקטופ קודם, RTL)
    focus-mode/          # React PWA — מסך עובד קצה (מובייל קודם)
  packages/
    core/                # @contake/core — הלב הגנרית, ללא תלות ב-IO:
                         #   graph/ (מודל Resource Graph)
                         #   domino/ (מנוע טהור: computeDomino)
                         #   rbac/ (מטריצת 22 הפעולות, ChangeRequest)
                         #   profiles/ (Domain Profiles כ-JSON + Zod)
                         #   contracts/ (Zod schemas + טיפוסי API משותפים)
    ui/                  # @contake/ui — Design System (בעלות: סוכן העיצוב)
    config/              # tsconfig, eslint, prettier משותפים
  infra/
    docker-compose.yml   # postgres + redis + api + mailhog
    deploy/              # render.yaml / fly.toml
  docs/                  # מסמכי הארכיטקטורה (הסט הזה)
```

כלל ברזל: כל הלוגיקה העסקית (גרף, דומינו, RBAC, חוקי פרופיל) יושבת ב-`packages/core` כפונקציות טהורות. `apps/api` רק מחבר אותן ל-HTTP/WS/DB. כך סוכן ה-Backend וסוכן ה-Frontend עובדים על אותו מנוע, והפרוטוטיפ הקיים (computeDomino בדפדפן) הוא כבר הוכחת-היתכנות של האיזומורפיות.

## 4. שירותים ותקשורת

- **API (Fastify)**: REST ל-CRUD ו-ChangeRequests; Socket.IO לעדכוני גרף חיים; תורי BullMQ לשני jobs: `domino.compute` ו-`notify.dispatch`.
- **Postgres**: מקור אמת יחיד. כל שינוי גרף נכתב גם לטבלת `change_log` (append-only): מי, מה, לפני/אחרי, ChangeRequest מקושר. זה הבסיס ל-audit ולמעקב דומינו. (Undo מוצהר מחוץ ל-Alpha — QA Sev-4.)
- **Realtime**: rooms לפי `event:{id}` ו-`scope:{siteId}`. עובד קצה מצטרף רק ל-room של המשימות שלו — הוא לא מקבל את הגרף המלא (עקבי עם מפת ה-RBAC).
- **Notifications worker**: צורך מהתור, ממיר impact set לרשימת נמענים, שולח דרך ספקים (מסמך ההתראות מפרט).

## 5. אבטחה ואכיפת RBAC (נקודות אכיפה)

1. **AuthHook** (preHandler) — אימות JWT/OTP בכל בקשה.
2. **ScopeHook** — פענוח תחום (event/site) והרשאת גישה לו.
3. **ImpactHook** — נקודת ההכרעה: כל mutation עובר `classifyImpact()` מ-core. S0 מאושר מיידית לפי תפקיד; S1-S3 הופך ל-ChangeRequest וממתין לאישור (לפי מפת ה-RBAC הקיימת: 22 פעולות, 4 דרגות).
4. **Rate limiting** (Throttler) על auth ו-report endpoints.
5. כל secrets ב-vault של הסביבה; אין מפתחות ב-repo. WhatsApp/SMS ב-Alpha רצים על sandbox בלבד.

## 6. סביבות

| סביבה | ייעוד | נתונים |
|---|---|---|
| local | docker-compose לכל סוכן | seed מלא: קייטנה + הפקה + יום צילום |
| staging | CI מפרוס אוטומטית מ-main | seed + reset לילי |
| demo | יציבה להדגמה לחיים | תרחיש האוטובוס המאחר + פרופילים נוספים |

## 7. בקרת גרסאות ותהליך

- trunk-based: ענפי feature קצרים, PR חובה, review צולב בין סוכנים, QA מאשר e2e.
- Conventional Commits; CHANGELOG אוטומטי.
- `packages/core` ו-`contracts/`: שינוי בהם דורש אישור Technical Lead (אני) — זהו החוזה שכל הצוות בונה מולו.
- תגיות: `alpha-m1` ... `alpha-m4` לפי אבני הדרך במסמך האינטגרציה.

## 7א. קונבנציות RTL נעוצות (Design v3.1, 2026-09-11)

- כל תווית מספרית/מעורבת על מסילת RTL (ציר זמן, שעות, מזהים לטיניים): direction-removal על המסילה + בידוד עם `<bdi>` לכל תווית. סטנדרט חובה ב-@contake/ui לכל רכיב עתידי (מקור: תיקון V-1, אומת על צילום מסך).
- מערכת קואורדינטות אחת לרכיבי ציר (ruler/bars/now-line) — אין חישובי offset נפרדים.
- Lint ב-gate של @contake/ui: אין `direction: ltr` שיורד לתאים מספריים בלי בידוד `<bdi>` (מקור: תצפית QA ב-G3 על .stat/.taskrows/.station — lint candidate, לא blocker).

## 8. פתוחים טכניים (לא חוסמים התחלה)

- בחירת BSP ל-WhatsApp Business (360dialog מול Twilio) — להחלטה בשבוע 6-7, אין צורך בחיים כאן; עלות חודשית צפויה נמוכה ב-sandbox.
- אחסון קבצים (תמונות ציוד/מסמכים) — ב-Alpha: ללא העלאות; placeholder URL בלבד.
