# Contake — שלד E2E דו־לשוני he-IL / en-US (חוק 05, שער v1.19)

**גרסה:** v0.1 · 17.09.2026 · **בעלים:** מהנדס אינטגרציה ו־E2E · **מעמד:** שלד מוכן להפעלה; חסום על contracts v1.19 (שרת) וחילוץ מחרוזות (FE).
**דרישת מקור מאומתת:** המייסד בוואטסאפ, 16.09 22:33: "אני רוצה שבגרסה הבאה שתעלה תהיה תמיכה גם באנגלית". מפרט תשתית: `contake-i18n-en-support-v0.1` (TL). חוקה: חוק 05 — "עברית ואנגלית הן שער אחד".

## 1. מה השלד מכסה (מיפוי לחוק 05 ולמפרט §5)

| # | בדיקה | ראיית מעבר | תלות | סטטוס |
|---|-------|-----------|------|-------|
| L1 | locale בפרופיל: GET `/v1/users/me/settings` → `{locale:'he'}` כברירת מחדל | API E2E | contracts v1.19 | ⬜ מוכן, מחכה לשרת |
| L2 | PATCH `{locale:'en'}` → נשמר בשרת, שורד logout+login | API E2E | contracts v1.19 | ⬜ מוכן |
| L3 | החלפת שפה משתקפת מיידית בלי refresh | Playwright | FE | ⬜ שלד |
| L4 | `dir="rtl"` ב־he / `dir="ltr"` ב־en ברמה העליונה; אפס CSS פיזי (left/right) | Playwright + סריקת CSS סטטית | FE | ⬜ שלד |
| L5 | פריסה תקינה בשני הכיוונים ב־360/390/430px, כל מסכי הליבה (login, tower, focus, approvals, builder) | Playwright, screenshots | FE | ⬜ שלד |
| L6 | תוכן מעורב־כיווני: שמות לטיניים בעברית, מספרים וטלפונים באנגלית — bidi נכון, אין הפיכת ספרות/סימנים | Playwright + fixtures קשים (כלל 12.5: תוכן קשה) | FE | ⬜ שלד |
| L7 | תאריכים/שעות דרך Intl לפי locale (en: 24h לפי המפרט) | Playwright | FE | ⬜ שלד |
| L8 | מונחי vertical בשני הLocales (terminology `{he,en}` לכל פרופיל) | Playwright × 7 פרופילים | v1.19 terminology schema | ⬜ שלד |
| L9 | הודעות push/notify מלוקלזות לפי locale של **הנמען** (server-side) | API E2E: user en מקבל תבנית en | backend notify | ⬜ מוכן, מחכה לשרת |
| L10 | אפס מחרוזות hardcoded (סריקה אוטומטית) | CI grep gate | FE | ⬜ שלד |

## 2. מבנה הטסטים (שלד)

```
tests/e2e-bilingual/
  bilingual.spec.ts          # L1-L7: זרימות לכל locale
  terminology.spec.ts        # L8: מונחים × פרופילים × locales
  notify-locale.spec.ts      # L9: server-side localization (API level)
  fixtures/
    hard-content.ts          # שמות ארוכים, mixed bidi, מספרים, אימוג'י, שגיאות
    locales.ts               # he-IL / en-US, viewports 360/390/430
  gates/
    no-hardcoded-strings.mjs # L10: סריקת מחרוזות עבריות/אנגליות קשיחות
    no-physical-css.mjs      # L4: left/right/text-align פיזי אסור
```

זרימת L1-L2 (API, רצה ראשונה כש־v1.19 עולה):

```
login(admin) -> GET /v1/users/me/settings        # expect { locale: 'he' }
PATCH /v1/users/me/settings { locale: 'en' }     # 200
GET /v1/users/me/settings                        # { locale: 'en' }
logout -> login                                  # עדיין en (server = source of truth)
PATCH { locale: 'he' }                           # החזרה — ניקוי
```

זרימת L9 (API): משתמש A (locale=en) משויך למשימה; admin מזיז משימה; נבדק שה־notify job שנבנה ל־A נושא תבנית/params באנגלית, ולמשתמש he בעברית — אותו אירוע, שני locales.

## 3. כללי שער (מהחוקה והמפרט)

- פיצ'ר שעובד רק בשפה אחת לא משתחרר — השער רץ על כל פיצ'ר חדש מ־v1.19.
- אין machine translation כמקור אמת; הטסטים בודקים נוכחות מפתח בקטלוג, לא איכות ניסוח (איכות: Design Lead + QA עצמאי).
- seed דו־לשוני הוא פריט נפרד — נפתח רק אם המייסד מזהה קהל דמו דובר־אנגלית.
- הרצה בשני הכיוונים על אותו build, אותם fixtures, בדיוק כמו רגרסיית הוורטיקלים (חוק 06).

## 4. מה צריך כדי להדליק את השלד

1. contracts v1.19 בשרת staging (locale field + settings endpoint) — Backend, לפי ה־drop-in של ה־TL.
2. גישה ל־FE repo (אין לי כרגע; FE לאמת נגישות) + Playwright config.
3. קטלוגי he.json/en.json ראשוניים — FE.
לאחר (1) אפעיל את L1-L2+L9 מול staging כ־API E2E (בעלייה בלבד על ה־harness הקיים), בלי לגעת בקוד FE/backend.
