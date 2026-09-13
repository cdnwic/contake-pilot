import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
let app: FastifyInstance; let repo: MemoryGraphRepository; let admin = '';
const H = (t: string) => ({ authorization: `Bearer ${t}` });
beforeEach(async () => {
  repo = MemoryGraphRepository.seeded(seedDemo());
  app = buildApp(repo, new AuthService(repo));
  await app.ready();
  admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } })).json().token as string;
});
describe('create-endpoint ground truth', () => {
  it('task.create actually creates', async () => {
    const before = (await repo.snapshot('e1'))!.tasks.length;
    const r = await app.inject({ method: 'POST', url: '/v1/events/e1/tasks', headers: H(admin), payload: { task: { name: 'משימת בדיקה', siteId: 'site-1', start: '2026-09-14T16:00:00+03:00', durationMin: 30 } } });
    const after = (await repo.snapshot('e1'))!.tasks.length;
    console.log('task.create: status', r.statusCode, 'tasks before/after:', before, after);
    expect(after).toBe(before + 1);
  });
  it('resource.create actually creates', async () => {
    const before = (await repo.snapshot('e1'))!.resources.length;
    const r = await app.inject({ method: 'POST', url: '/v1/events/e1/resources', headers: H(admin), payload: { resource: { resourceKind: 'location', name: 'חדר בדיקה', exclusive: true } } });
    const after = (await repo.snapshot('e1'))!.resources.length;
    console.log('resource.create: status', r.statusCode, 'resources before/after:', before, after);
    expect(after).toBe(before + 1);
  });
  it('dependency.create actually creates', async () => {
    const before = (await repo.snapshot('e1'))!.dependencies.length;
    const r = await app.inject({ method: 'POST', url: '/v1/events/e1/dependencies', headers: H(admin), payload: { fromTaskId: 't5', toTaskId: 't7' } });
    const after = (await repo.snapshot('e1'))!.dependencies.length;
    console.log('dependency.create: status', r.statusCode, 'deps before/after:', before, after);
    expect(after).toBe(before + 1);
  });
  it('approve path full dump', async () => {
    const fm = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fm@camp.local', password: 'fm12345' } })).json().token as string;
    const r2 = await app.inject({ method: 'PATCH', url: '/v1/tasks/t1', headers: H(fm), payload: { version: 1, move: { newStart: '2026-09-14T07:45:00+03:00' } } }); // 07:45 escalates to CR (08:20 returns blockedPreview, S3 collision)
    console.log('FM move status', r2.statusCode, 'keys:', Object.keys(r2.json()));
    const cr2 = r2.json().changeRequest;
    const ap = await app.inject({ method: 'POST', url: `/v1/changes/${cr2.id}/approve`, headers: H(admin) });
    console.log('approve status', ap.statusCode, 'body:', ap.body.slice(0, 200));
    console.log('cr state:', await repo.getChangeRequest(cr2.id)?.state, 't1 start:', await repo.getTask('t1')?.start);
  });
});
