#!/usr/bin/env node
/** Generate a canonical users-phone backup MAC key (QA 2026-09-18 v6):
 *  32 crypto-strong bytes as 64 lowercase hex. Print ONCE for the operator
 *  to provision into the managed secret store as CONTAKE_BACKUP_MAC_KEY.
 *  This script never writes the key anywhere. */
import { generateBackupMacKey } from '../dist/services/phone-migration.js';
const key = generateBackupMacKey();
const keyId = `bkp-${new Date().toISOString().slice(0, 10)}-v1`;
console.log('users-phone backup MAC key (provision into the managed secret store, then clear your scrollback):');
console.log(`CONTAKE_BACKUP_MAC_KEY=${key}`);
console.log(`CONTAKE_BACKUP_KEY_ID=${keyId}`);
console.log('CONTAKE_BACKUP_ENV=<unique deployment/database ID, e.g. contake-prod-pg-01 - one ID + key per deployed database, NEVER shared>');
console.error('CUSTODY: never commit, never pass via argv, never store inside artifacts, never log.');
