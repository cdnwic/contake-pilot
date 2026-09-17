/** DIAGNOSTIC ONLY (QA-authorized suite-context diagnostic, 2026-09-17).
 *  Behavior-neutral observer: emits lifecycle events to G4_EXT_LOG as JSONL.
 *  No effect on pool, sequencing, workers, timeouts, or results. */
import { appendFileSync } from 'node:fs';

const OUT = process.env['G4_EXT_LOG'];
const ev = (e, extra = {}) => {
  if (!OUT) return;
  try { appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), ev: e, pid: process.pid, ...extra }) + '\n'); } catch { /* observer only */ }
};
const mid = (m) => { try { return m?.moduleId ?? m?.id ?? 'unknown'; } catch { return 'unknown'; } };
const mstate = (m) => { try { return m?.state?.() ?? null; } catch { return null; } };
const safeLen = (x) => { try { return Array.isArray(x) ? x.length : (typeof x?.size === 'number' ? x.size : null); } catch { return null; } };

export default class G4DiagReporter {
  onInit() { ev('reporter-init'); }
  onTestRunStart(specs) { ev('run-start', { files: safeLen(specs) }); }
  onTestModuleCollected(m) { ev('collection', { file: mid(m) }); }
  onTestModuleStart(m) { ev('file-start', { file: mid(m) }); }
  onTestModuleEnd(m) { ev('worker-result', { file: mid(m), state: mstate(m) }); }
  onTestRunEnd(modules, errors, reason) { ev('summary', { files: safeLen(modules), errors: safeLen(errors), reason: reason == null ? null : String(reason) }); }
  onFinished() { ev('reporter-finished'); }
}
