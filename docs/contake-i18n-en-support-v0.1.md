# Contake — תמיכה באנגלית (i18n/L10n): מפרט ארכיטקטורה v0.1
**תאריך:** 16 בספטמבר 2026 | **מחבר:** Technical Lead | **דרישת מקור:** המייסד, 16.9 22:33 ("בגרסה הבאה שתעלה תהיה תמיכה גם באנגלית")
**אילוץ:** לא נכנס ל-build של דמו חמישי. ה-build הנוכחי קפוא ועבר QA. יעד: הגרסה שעולה אחרי הדמו.

## 1. מצב קיים (נבדק היום מול main @ a32d1c0)
- אין שום תשתית i18n: לא ב-API, לא ב-FE.
- API: מחרוזות עברית קשיחות ב-app.ts (~89 מוקדי תווים עבריים), services/changes.ts (~26), תבניות notify, וסיכומי דומינו בעברית מורכבים ב-server.
- FE (repo נפרד): מחרוזות UI בעברית + שכבת terminology רב-וורטיקלית (registry v1.3) — גם היא עברית-בלבד כיום.
- seeds/demo data בעברית (שמות משימות, אירועים) — זה content, לא UI strings; טיפול נפרד (סעיף 7).
- QA harness כבר מניח locale בדיקה אחת (he-IL, Asia/Jerusalem).

## 2. עקרונות קשיחים (מהדרישה)
- עברית ואנגלית שתיהן אזרחות מלאה. אין machine translation כמקור אמת; כל מחרוזת עוברת ניסוח מקצועי (DL + עורך), QA בודק בשני הכיוונים.
- RTL/LTR אמיתי: `dir` ברמה העליונה, CSS logical properties בלבד (margin-inline, padding-inline, inset-inline), אפס "mirroring" ידני, אפס תיקוני bidi אד-הוק. תוכן מעורב (מספרים, שמות לטיניים בעברית ולהפך) מקבל טיפול bidi מפורש.
- Language switch גלוי + העדפה נשמרת per-user (שרת) עם fallback מקומי.

## 3. ארכיטקטורה
### 3.1 API (backend)
- שדה `locale: 'he'|'en'` על פרופיל המשתמש. ברירת מחדל: he.
- contracts v1.19 (additive, TL-owned): `GET/PATCH /users/me/settings { locale }`; תבניות notify עוברות ל-keyed messages עם מחרוזת per-locale; סיכומי דומינו עוברים למבנה message-code + params, כשה-server מלוקליז לפי locale של **הנמען** (push/SMS חייבים לוקליזציה בצד שרת).
- תגובות API נשארות מובנות (structured data); מחרוזות תצוגה מורכבות בצד הלקוח איפה שאפשר, בצד השרת רק לערוצי push/SMS/in-app stored notifications.
- שמירת העדפה: PATCH מה-FE ב-login ובשינוי ידני; sync דו-כיווני (server = source of truth).

### 3.2 FE
- ספריית i18n (i18next או שקיל קל — החלטת FE בכפוף ל-bundle budget של מובייל); כל מחרוזות ה-UI מחולצות לקטלוגי he.json / en.json.
- שכבת terminology הופכת דו-לשונית: לכל פרופיל, term: { he, en }. הקובץ הנוכחי (terminology.ts, sha 8c116def) מקבל הרחבה additively — לא נכתב מחדש.
- Switch: בעוד-מ menu + מסך התחברות; זיהוי ראשוני מ-`navigator.language`, דריסה בהעדפה השמורה.
- מספרים/תאריכים/שעות דרך `Intl` לפי locale (en-US: 12h או 24h לפי ההחלטה — להחליט, ברירת מחדל 24h לשמירת דיוק תפעולי).
- בדיקת כל פלטת CSS פיזית (left/right/text-align) והמרה ל-logical.

### 3.3 תוכן דמו
- בגרסה הראשונה: UI דו-לשוני, נתוני הדמו נשארים עבריים (עם תרגום ל-6 וורטיקלים כ-stretch). אם הדמו הבא יהיה מול קהל אנגלוי — seed דו-לשוני הוא פריט נפרד (1-2 ימים).

## 4. חלוקת עבודה ותלויות
| בעלים | משימה | הערכה |
|---|---|---|
| TL (אני) | contracts v1.19 hooks (locale field, keyed notify templates, bilingual terminology schema) | 0.5-1 יום |
| Backend | locale על משתמש, settings endpoint, לוקליזציית notify/דומינו per-recipient | 1-2 ימים |
| FE | חילוץ מחרוזות + framework + switch + logical CSS + persistence sync | 2-4 ימים (תלוי נפח מחרוזות — repo ה-FE לא נגיש לי, FE לאמת) |
| Design Lead | ניסוח אנגלי מקצועי (לא תרגום מכונה), בחירת גופן Latin תואם, טון | 1-2 ימים, במקביל |
| QA עצמאי | gate דו-לשוני: bidi, מספרים מעורבים, קטיעות, פריסה בשני הכיוונים, Playwright he-IL + en-US | 1-2 ימים |

סה"כ משוער: 4-7 ימי עבודה מצטברים, ניתן לרוץ בעקבות הדמו ולנחות בגרסה שאחריו. תלוי ב-design system החדש רק בקטע ה-copy/גופן — התשתית לא נחסמת עליו.

## 5. קריטריון קבלה (QA gate)
- מסך = שפה אחת שלמה, אפס מחרוזות hardcoded נותרות (סריקה אוטומטית + QA ידני).
- החלפת שפה משתקפת מיידית, שורדת refresh ו-login מחדש (server preference).
- אפס שבירות פריסה ב-LTR וב-RTL ב-360/390/430px; מספרים ותאריכים נכונים בשני הLocales.
- הדממה: אותו משתמש מקבל push באנגלית אחרי החלפת העדפה.
