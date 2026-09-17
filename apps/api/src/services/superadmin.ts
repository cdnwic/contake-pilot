/** Super Admin test impersonation environment (dedicated sandbox tenant).
 *  The sandbox org is structurally separate from every real tenant: all
 *  effects of a test-impersonation session land here and only here, so
 *  profile-switch testing can never touch real users or production data. */
import type { ID } from '@contake/core';
import type { GraphRepository } from '../repo/graph-repository.js';

export const SUPERADMIN_SANDBOX_ORG: ID = 'org-superadmin-sandbox';
export const SUPERADMIN_SANDBOX_SITE: ID = 'sa-site-1';
export const sandboxEventId = (profileId: string): ID => `sa-ev-${profileId}`;
export const sandboxResourceId = (profileId: string): ID => `sa-r-${profileId}`;

/** Idempotent PER ARTIFACT (QA stop-ship 2026-09-17): each sandbox artifact
 *  (event, worker resource, one task) is ensured independently, so a sandbox
 *  left partial by an older failure is repaired instead of skipped. Adapter
 *  creates are upserts, so concurrent ensures of identical content are safe.
 *  Never touches other tenants. Call inside the impersonation transaction
 *  (app.ts wraps ensure + identity mint + start audit in withAuditSafety). */
export async function ensureSuperAdminSandbox(repo: GraphRepository, profileId: string): Promise<void> {
  const evId = sandboxEventId(profileId);
  if (!(await repo.getEvent(evId))) {
    await repo.createEvent({
      id: evId, kind: 'event', orgId: SUPERADMIN_SANDBOX_ORG, domainProfileId: profileId,
      name: `Sandbox ${profileId}`, date: '2026-09-14', timezone: 'Asia/Jerusalem',
      siteIds: [SUPERADMIN_SANDBOX_SITE], status: 'published', version: 1,
    });
  }
  if (!(await repo.getResource(sandboxResourceId(profileId)))) {
    await repo.createResource({
      id: sandboxResourceId(profileId), kind: 'resource', eventId: evId,
      resourceKind: 'person', name: 'Test Worker', exclusive: true, version: 1,
    });
  }
  const taskId = `sa-t-${profileId}-1`;
  if (!(await repo.getTask(taskId))) {
    await repo.createTask({
      id: taskId, kind: 'task', eventId: evId, siteId: SUPERADMIN_SANDBOX_SITE,
      name: 'Sandbox task', start: '2026-09-14T10:00:00+03:00', durationMin: 30,
      status: 'planned', locked: false, assigneeResourceIds: [sandboxResourceId(profileId)], version: 1,
    });
  }
}
