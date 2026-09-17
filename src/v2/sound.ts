/**
 * Contake Sound Kit v1 - "Warm Wood + The Wave" (SOUNDS.md source of truth).
 * WebAudio synthesis: sine f0 + sine 2.01*f0 (-23dB) "warm"; wood adds
 * triangle 4.02*f0 (-15dB) + sine 9.8*f0 (-26dB). One shared AudioContext,
 * resume() on first gesture. 600ms minimum re-trigger gap per event type.
 * Global mute: localStorage "contake-sounds-muted" = "1" mutes everything
 * except critical, which degrades to haptics-only.
 */

export type SoundEvent =
  | 'notify_info'
  | 'approval_request'
  | 'approved'
  | 'domino_warning'
  | 'critical'
  | 'task_done'
  | 'reminder_tick';

let AC: AudioContext | null = null;
const lastPlay: Partial<Record<SoundEvent, number>> = {};

function pluck(freq: number, t0: number, dur: number, vol: number, timbre?: 'wood'): void {
  if (!AC) return;
  const o1 = AC.createOscillator();
  const o2 = AC.createOscillator();
  const g = AC.createGain();
  o1.type = 'sine';
  o1.frequency.value = freq;
  o2.type = timbre === 'wood' ? 'triangle' : 'sine';
  o2.frequency.value = freq * (timbre === 'wood' ? 4.02 : 2.01);
  const g2 = AC.createGain();
  g2.gain.value = timbre === 'wood' ? 0.18 : 0.07;
  o2.connect(g2); g2.connect(g); o1.connect(g); g.connect(AC.destination);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o1.start(t0); o2.start(t0); o1.stop(t0 + dur); o2.stop(t0 + dur);
}

const KIT: Record<SoundEvent, (t: number) => void> = {
  notify_info:      (t) => pluck(659.25, t, 0.5, 0.5),                                    // E5
  approval_request: (t) => { pluck(587.33, t, 0.4, 0.5); pluck(783.99, t + 0.17, 0.45, 0.5); },
  approved:         (t) => { pluck(587.33, t, 0.45, 0.5); pluck(739.99, t + 0.11, 0.45, 0.5); pluck(880, t + 0.22, 0.6, 0.5); },
  domino_warning:   (t) => { pluck(493.88, t, 0.55, 0.45, 'wood'); pluck(392, t + 0.19, 0.65, 0.45, 'wood'); },
  critical:         (t) => { pluck(220, t, 0.16, 0.65, 'wood'); pluck(329.63, t + 0.14, 0.3, 0.5, 'wood'); pluck(220, t + 0.34, 0.16, 0.65, 'wood'); pluck(329.63, t + 0.48, 0.4, 0.5, 'wood'); },
  task_done:        (t) => { pluck(587.33, t, 0.4, 0.5); pluck(739.99, t + 0.1, 0.4, 0.5); pluck(880, t + 0.2, 0.4, 0.5); pluck(1174.66, t + 0.3, 0.8, 0.5); },
  reminder_tick:    (t) => pluck(783.99, t, 0.12, 0.5, 'wood'),                           // G5 tick
};

const HAPTICS: Record<SoundEvent, number | number[]> = {
  notify_info: 10,
  approval_request: 25,
  approved: 18,
  domino_warning: 35,
  critical: [60, 40, 60],
  task_done: [14, 40, 14],
  reminder_tick: 8,
};

export function soundsMuted(): boolean {
  try { return localStorage.getItem('contake-sounds-muted') === '1'; } catch { return false; }
}
export function setSoundsMuted(muted: boolean): void {
  try { localStorage.setItem('contake-sounds-muted', muted ? '1' : '0'); } catch { /* private mode */ }
}

/** Play a kit event + its haptic. Respects mute (critical degrades to haptics-only)
 *  and the 600ms per-event re-trigger gap. */
export function sound(name: SoundEvent): void {
  const now = performance.now();
  if (lastPlay[name] && now - lastPlay[name]! < 600) return;
  lastPlay[name] = now;

  const muted = soundsMuted();
  if (!muted || name === 'critical') {
    if (navigator.vibrate) navigator.vibrate(HAPTICS[name]);
  }
  if (muted) {
    // muted: everything silent; critical already gave haptics-only above
    return;
  }
  try {
    AC = AC || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (AC.state === 'suspended') void AC.resume();
    KIT[name](AC.currentTime + 0.02);
  } catch { /* audio unavailable - haptics already fired */ }
}