# Contake — פרוטוקול שימור (Preservation Protocol) v1.0 [superseded by v1.1]
**מקור:** הוראת מייסד, WhatsApp 17.9.2026 02:40 IDT (relay דרך main) | **מעמד:** הוחלף ב-v1.1 (הפרדת ארtefacts מ-domain data, שער no-loss, קנוני). נשמר לתיעוד.

## 1. כלל הברזל
כל ארtefact שנוצר — נשמר. דחוי, מוחלף, לא-בשימוש, לא-שוחרר — כולם נשמרים. "לא בשימוש" ≠ "למחיקה". לעולם.

## 2. סקופ
קוד ומקורות (כולל ענפים), מועמדי עיצוב (כולל דחויים), מסמכים, חוזים (כולל טיוטות מבוטלות), בדיקות, ראיות, seeds ופיקסצ'רים, build/release artifacts (commit SHA + Surge rev בזוג).

## 3. מיקום קנוני
ריפו cdnwic/contake-pilot: docs/ artifacts/ scripts/e2e/evidence/ seeds/. פריטים גדולים: sha256 + מיקום מפורש ברישום.

## 4. מטאדטה חובה
גרסה, חותמת זמן, provenance, סטטוס: active | superseded | rejected | archive.

## 5. רישום
docs/REGISTRY.md — אינדקס יחיד. פריט שלא ברישום = לא קיים.

## 6. מחיקה
רק רגיש-אבטחה או זמני-מיסודו; מתועד ב-docs/DELETION-LOG.md לפני הביצוע. מחיקה שקטה = הפרה.
