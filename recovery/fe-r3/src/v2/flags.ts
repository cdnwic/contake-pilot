/** Feature gates pending the v1.12 contract (TL ruling 2026-09-14).
 *  Wiring stays intact behind the flags; UI must not ship dead actions. */
export const V12_REPORT_RESOLVE = false; // POST /v1/reports/:id/resolve -> "טופל" quick action
export const V12_CONTACT_PHONE = false;  // ResourceNode.contactPhone -> "התקשר" quick action

/** Reject quick-pick reasons per case kind — DESIGN v3.1 §3: config, not hardcoded.
 *  "אחר" is always appended by the UI and opens an inline free-text field. */
export const REJECT_REASONS: Record<string, string[]> = {
  'שיבוץ': ['השיבוץ לא מתאים', 'חסר אישור הורה'],
  'חניכים': ['מעבר לקיבולת', 'חסרים פרטים', 'לא מאושר מראש'],
  'מחיקה': ['המשימה עדיין נדרשת'],
  'ציוד': ['הציוד לא הוחזר'],
  'אישור': [],
};