import { useClientState, useSendNotifications } from '../hooks';
import { useSession } from '../state';
import { Card, Chip, Empty } from '../ui';
import type { DomainProfile, NotificationJob, NotificationTarget } from '../contracts/contake-core-contracts.v1.1';

/** Group targets by Hebrew stakeholder base label ("מדריך א" → "מדריך", "הורי קבוצת דובדבן (28)" → parents channel). */
const PLURALS: Record<string, string> = {
  'מדריך': 'מדריכים', 'הורה': 'הורים', 'צוות': 'אנשי צוות', 'טכנאי': 'טכנאים', 'מפיק': 'מפיקים',
  'נהג': 'נהגים', 'מלווה': 'מלווים', 'מוביל': 'מובילים', 'מפעיל': 'מפעילים', 'חונך': 'חונכים',
};
function baseLabel(label: string): string {
  const m = /^([^\d(]+)/.exec(label);
  return (m?.[1] ?? label).trim().replace(/ [א-ת]$/, '');
}
function groupCounts(targets: NotificationTarget[]): string {
  const groups = new Map<string, number>();
  for (const t of targets) {
    const b = baseLabel(t.recipientLabel);
    groups.set(b, (groups.get(b) ?? 0) + 1);
  }
  return [...groups.entries()].map(([b, n]) => `${n} ${PLURALS[b] ?? b}`).join(' · ');
}
function renderTemplate(profile: DomainProfile, job: NotificationJob): string {
  const tpl = profile.notificationTemplates[job.templateKey as keyof DomainProfile['notificationTemplates']] ?? job.templateKey;
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => job.params[k] ?? '');
}
const KIND_HE: Record<string, string> = {
  task_moved: 'שינוי מועד', task_delayed: 'איחור', task_cancelled: 'ביטול משימה',
  task_assigned: 'שיבוץ חדש', task_unassigned: 'ביטול שיבוץ', change_needs_approval: 'ממתין לאישור', digest_multi_change: 'עדכון מצטבר',
};

export function SyncView() {
  const { data } = useClientState();
  const { showToast, role } = useSession();
  const send = useSendNotifications();
  if (!data) return <Empty>טוען…</Empty>;
  const { pendingNotifications, profile } = data;
  const canSend = role === 'admin';
  const totalTargets = pendingNotifications.reduce((n, j) => n + j.targets.length, 0);

  return (
    <div>
      <Card title="סנכרון בעלי עניין" sub="מי מקבל מה — נגזר מאישור שינוי בלבד"
        actions={canSend && pendingNotifications.length > 0 ? (
          <button className="btn primary" onClick={() => send.mutate(undefined, { onSuccess: (r) => showToast(r.messageHe || `נשלחו ${r.sent} עדכונים`) })} aria-label="שליחת כל העדכונים הממתינים">
            שלח הכל ({pendingNotifications.length})
          </button>
        ) : undefined}>
        {!pendingNotifications.length && <Empty>אין עדכונים ממתינים. לאחר אישור שינוי בלוח, תצוגת העדכן תופיע כאן לבדיקה לפני שליחה.</Empty>}
        <div className="stack">
          {pendingNotifications.map((j) => (
            <div className="stub" key={j.id} aria-label={`תצוגת עדכן: ${KIND_HE[j.kind] ?? j.kind}`}>
              <div className="head">
                <span className="who">עדכן: {j.params['taskName'] ? `${KIND_HE[j.kind] ?? j.kind} — ${j.params['taskName']}` : KIND_HE[j.kind] ?? j.kind}</span>
                <span className="count">{groupCounts(j.targets)}</span>
              </div>
              <div className="msg">{renderTemplate(profile, j)}</div>
              <div className="foot">
                <Chip kind="risk">ממתין לאישור</Chip>
                <span className="meta">{j.targets.length} נמענים · {j.holdUntil ? 'נדחה לשעות שקט' : 'שליחה מיידית'}</span>
              </div>
            </div>
          ))}
          {pendingNotifications.length > 0 && (
            <p className="meta">סה״כ {totalTargets} נמענים · משימות קפואות אינן מייצרות עדכון · שיבוץ מחדש מודיע לאנשים בלבד (v1.3).</p>
          )}
        </div>
      </Card>
      <Card title="תקשורת אחרונה" sub="מיומן הביקורת">
        {data.audit.filter((a) => a.action === 'notify.send.targeted').length === 0 && <Empty>טרם נשלחו עדכונים.</Empty>}
        {data.audit.filter((a) => a.action === 'notify.send.targeted').length > 0 && (
          <table className="taskrows">
            <thead><tr><th scope="col">שעה</th><th scope="col">פעולה</th><th scope="col">מבצע</th></tr></thead>
            <tbody>{data.audit.filter((a) => a.action === 'notify.send.targeted').map((a, i) => (
              <tr key={i}><td className="t">{new Date(a.createdAt).toLocaleTimeString('he-IL')}</td><td>{a.entityType} · {a.entityId}</td><td>{a.actorUserId}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}