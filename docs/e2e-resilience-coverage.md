# Contake — כיסוי אמינות: אופליין / רשת חלשה / כפילויות / סדר (חוקים 04, 18)

**גרסה:** v1.0 · 17.09.2026 · **בעלים:** מהנדס אינטגרציה ו־E2E · **מעמד:** מסמך כיסוי חי; מתעדכן עם כל הרחבת בדיקות.
**מטרה:** מטריצה אחת שעונה על החוקה — "בדיקות offline, רשת חלשה, reconnect, retry, כפילויות, out-of-order ו־idempotency" (חוק 04) ו־"idempotency keys מחייבים לכל POST/PATCH/DELETE" (חוק 18) — מה קיים, איפה הראיה, ומה פתוח.

## 1. מטריצת כיסוי

| # | תרחיש | שכבה | כיסוי קיים | ראיה | סטטוס |
|---|-------|------|-----------|------|-------|
| R1 | אותו `clientReportId` נשלח פעמיים → אפקט אחד | unit/inject | `qa-m3-offline-probes.test.ts` OQ-1 | dedupe ב־`POST /v1/reports` (`getReportByClientId`) | ✅ קיים |
| R2 | `clientTimestamp` מקורי נשמר על הרשומה | unit/inject | OQ-2 | שדה `clientTimestamp` | ✅ קיים |
| R3 | replay לא-בסדר: delayed(14:05) ואז ok(14:02) | unit/inject | OQ-3 | שניהם נקלטים, סדר לפי clientTimestamp | ✅ קיים |
| R4 | retry כפול של mutation (אותה גרסה) → בלי double-apply | **live API E2E** | `scripts/e2e/vertical-domino.mjs` | `409 VERSION_CONFLICT`, הגרף לא זז | ✅ first pass (6+1 וורטיקלים) |
| R5 | out-of-order arrival של mutations על אותה משימה | live API E2E | אותו מנגנון (version optimistic concurrency) | stale version → 409 | ✅ first pass |
| R6 | idempotency keys לכל POST/PATCH/DELETE (חוק 18) | contracts+server | **חלקי**: reports בלבד (clientReportId). שאר ה־mutations מוגנים ב־version concurrency, לא ב־idempotency key | אין header/field מוסכם ב־contracts v1.18 | ⚠️ פער — דורש החלטת TL (contracts v1.20?) |
| R7 | אופליין ב־Focus Mode: תור דיווחים מקומי ושידור מאוחר | client/FE | `docs/qa-e2e-journeys.md` E2E-9 מוגדר, לא אוטומט | — | ⬜ פתוח (FE/Playwright) |
| R8 | רשת מנופחת 3G: timeouts, retry עם backoff, UX | client/FE | — | — | ⬜ פתוח |
| R9 | reconnect של realtime (socket) אחרי ניתוק: resync מלא | client+server | — | — | ⬜ פתוח |
| R10 | retry של dispatch (notify jobs) אחרי כשל ספק | server | dispatcher + state store; ספקים sandboxed | `dispatch.ts` | ✅ יחסית (unit) — להוסיף probe חי |
| R11 | offline → reconnect → שליחת תור כפולה חלקית (dup באמצע queue) | E2E מלא | — | — | ⬜ פתוח (הרחבת harness) |

## 2. first pass שבוצע (17.09, harness v1)

ה־harness (`scripts/e2e/vertical-domino.mjs`) רץ חי מול ה־API (localhost all-demo + staging) ומוכיח בכל וורטיקל:
- R4/R5: שליחה כפולה של אותו `task.move` עם אותה `version` → `409 VERSION_CONFLICT`; snapshot הגרף זהה לפני ואחרי הניסיון הכפול (אין cascade כפול).
- נקודתית לחוק 03: קריאה/כתיבה cross-tenant → 404.
- ניקוי מלא באותה session + סריקת שאריות `zz-qa-` (שארית = כשלון ריצה, לפי כללי ה־TL).

## 3. פערים ומומלצים (להכרעת TL / רשות האיכות)

1. **R6 — idempotency keys**: חוק 18 מחייב key לכל כתיבה; כיום קיים רק ב־reports. הצעה: header `Idempotency-Key` אופציונלי ב־contracts v1.20, שרת שומר (key, actor) → תגובה ראשונה ל־24h. בינתיים version-concurrency מכסה retry כפול אבל לא replay אחרי timeout לא ידוע.
2. **R9 — realtime reconnect**: אין ראיה שאחרי ניתוק socket הלקוח מבצע resync (JOIN מחדש + snapshot). דורש client; לתאם עם FE.
3. **R7/R8/R11**: דורשים Playwright + throttling (CDP) — חלק משלד ה־E2E הדו־לשוני/שטח; בעלות: אינטגרציה + FE.
4. ממצא לוואי (severity נמוך): בקשה עם `content-type: application/json` וגוף ריק (POST publish / DELETE) נופלת ל־500 `INTERNAL` במקום 400 נקי — Fastify parser error לא ממופה. תוקף: ניסוח שגיאה בלבד.

## 4. כללי ריצה (TL, מחייבים)

- קידומת `zz-qa-` לכל ישות; יצירה ומחיקה מלאה באותה session; שארית = כשלון + דיווח.
- לא נוגעים ב־seeded demo content או `cd-ev1`. API בלבד, לא FE של הדמו.
- ריצה סדרתית על free-tier; עצירה על 429. blackout חמישי 08:00–14:00 (ברירת מחדל) מובנית ב־harness.
