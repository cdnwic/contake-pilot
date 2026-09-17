/** Boot addendum: the matrix version pin is single-sourced in server.ts and the
 *  boot-fail check must refuse a mismatched drop-in. This test pins the pin. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS, RBAC_MATRIX_VERSION } from '@contake/core';

describe('boot matrix pin', () => {
  it('server.ts single-sources the pin and it matches the loaded matrix', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const m = src.match(/export const PINNED_MATRIX_VERSION = '([^']+)'/);
    expect(m, 'server.ts must export PINNED_MATRIX_VERSION').toBeTruthy();
    expect(m![1]).toBe(RBAC_MATRIX_VERSION);
    expect(RBAC_MATRIX_VERSION).toBe('1.6');
    // boot-fail check retained next to the pin
    expect(src).toContain('refusing to boot');
    // remediation matrix carries the three new actions (45 -> 48)
    expect(ALL_ACTIONS.length).toBe(48);
    expect(ALL_ACTIONS).toContain('channel.optout');
    expect(ALL_ACTIONS).toContain('task.advance');
    expect(ALL_ACTIONS).toContain('report.correct');
  });
});
