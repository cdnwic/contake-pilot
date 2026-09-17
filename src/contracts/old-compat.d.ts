/** REWRITE (r3): module augmentation restoring fields the old views/notify code used from
 *  contract versions lost to era skew (v1.2-v1.8). Evidence contract files stay verbatim.
 *  Optional-only additions: runtime-unsafe assumptions are logged in REBUILD-LOG. */
import type { ProposedChange } from './contake-core-contracts.v1.1';

declare module './contake-core-contracts.v1.1' {
  interface ChangeRequest { proposedChange?: { type: string; taskId?: string; delayMin?: number } }
  interface Impact { channelType?: string }
  interface StatusReport { receivedAt?: string; outcome?: string }
  interface NotificationJob { holdUntil?: string }
}
