import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryGraphRepository } from '../src/repo/memory.js';
import { seedDemo } from '../src/seed.js';
it('create endpoints return createdId', async () => {
  const repo = MemoryGraphRepository.seeded(seedDemo());
  const app = buildApp(repo, new AuthService(repo));
  await app.ready();
  const admin = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@camp.local', password: 'admin123' } })).json().token as string;
  const H = { authorization: `Bearer ${admin}` };
  const t = await app.inject({ method: 'POST', url: '/v1/events/e1/tasks', headers: H, payload: { task: { name: 'x', siteId: 'site-1', start: '2026-09-14T16:00:00+03:00', durationMin: 30 } } });
  console.log('task.create:', t.body.slice(0, 220));
  const r = await app.inject({ method: 'POST', url: '/v1/events/e1/resources', headers: H, payload: { resource: { resourceKind: 'location', name: 'y', exclusive: true } } });
  console.log('resource.create:', r.body.slice(0, 220));
  const d = await app.inject({ method: 'POST', url: '/v1/events/e1/dependencies', headers: H, payload: { fromTaskId: 't5', toTaskId: 't7' } });
  console.log('dependency.create:', d.body.slice(0, 220));
  await app.close();
});
