/** Settings (PR-4): "התראות push" toggle + registered-device management (spec §5-§6).
 *  The toggle reflects the LIVE browser permission and this device's subscription —
 *  never a stored flag — so an OS-level revocation shows as OFF. Device list comes
 *  from the owner's self-service route; removing the current device also unsubscribes
 *  the browser. Mock mode: management is live-only — the section explains instead of
 *  touching any harness state (QA E2E hooks unaffected). */
import { useCallback, useEffect, useState } from 'react';
import type { PushSubscription } from '../contracts/contake-core-contracts.v1.10';
import { isLiveMode } from '../api/session';
import {
  currentEndpoint, deleteSubscription, listSubscriptions, pushPermission, pushSupported, subscribePush, unsubscribePush,
} from '../api/push';

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('he-IL', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
};

export function SettingsView() {
  const live = isLiveMode();
  const supported = pushSupported();
  const [perm, setPerm] = useState(pushPermission());
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushSubscription[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!live || !supported) return;
    setPerm(pushPermission());
    setEndpoint(await currentEndpoint());
    if (pushPermission() === 'granted') {
      setDevices(await listSubscriptions().catch(() => null));
    } else {
      setDevices([]);
    }
  }, [live, supported]);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) {
        const p = pushPermission() === 'granted' ? 'granted' : await Notification.requestPermission();
        if (p !== 'granted') { setPerm(pushPermission()); return; } // denied/dismissed: toggle stays OFF (live state)
        await subscribePush();
      } else {
        await unsubscribePush();
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'הפעולה נכשלה — נסה שוב');
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (ep: string) => {
    setBusy(true);
    setError(null);
    try {
      if (ep === endpoint) await unsubscribePush();
      else await deleteSubscription(ep);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ההסרה נכשלה — נסה שוב');
    } finally {
      setBusy(false);
    }
  };

  const on = perm === 'granted' && endpoint !== null;

  return (
    <section className="settings" aria-label="הגדרות">
      <h1 className="settings-title">הגדרות</h1>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <p className="push-title">התראות push</p>
            <p className="push-sub">עדכונים על שינויים שדורשים את תשומת לבך — גם כשהאפליקציה סגורה.</p>
          </div>
          {live && supported ? (
            <button
              type="button"
              className={`push-toggle${on ? ' on' : ''}`}
              role="switch"
              aria-checked={on}
              aria-label="התראות push"
              disabled={busy}
              onClick={() => void toggle(!on)}
            >
              <span className="knob" aria-hidden="true" />
              <span className="state">{on ? 'פעיל' : 'כבוי'}</span>
            </button>
          ) : (
            <p className="push-sub">ההתראות זמינות במצב חי (?api=live) בדפדפן שתומך ב-push.</p>
          )}
        </div>
        {perm === 'denied' && live && (
          <p className="warn risk" role="status">ההתראות חסומות בדפדפן — לאפשר: סמל המנעול בשורת הכתובת ← הגדרות אתר ← התראות ← אפשרו, ואז רעננו.</p>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>

      {live && supported && devices !== null && devices.length > 0 && (
        <div className="settings-card">
          <p className="push-title">מכשירים רשומים</p>
          <ul className="push-devices">
            {devices.map((d) => (
              <li key={d.id} className="push-device">
                <span className="device-class">{d.deviceClass ?? 'דפדפן'}</span>
                <span className="device-when tnum">{fmtWhen(d.createdAt)}</span>
                {d.endpoint === endpoint && <span className="device-this">מכשיר זה</span>}
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => void removeDevice(d.endpoint)}
                  aria-label={`הסרת המכשיר ${d.deviceClass ?? 'דפדפן'} מ-${fmtWhen(d.createdAt)}`}
                >הסרה</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}