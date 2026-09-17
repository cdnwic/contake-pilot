import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:4173/';
const OUT = '/home/sandbox/release/fe-rebuild/qa/parity/';
const views = ['tower', 'builder', 'approvals', 'incidents', 'sync'];
const roles = ['admin', 'field_manager', 'focus_worker'];
const verticals = ['camp', 'film-shoot', 'conference'];
const widths = [360, 390, 430];
const shots = [];
// views x roles at camp/390
for (const v of views) for (const r of roles)
  shots.push({ name: `${v}-${r}-camp-390`, url: `#/${v}?profile=camp&role=${r}`, w: 390 });
// verticals x tower admin 390
for (const p of verticals)
  shots.push({ name: `tower-admin-${p}-390`, url: `#/tower?profile=${p}&role=admin`, w: 390 });
// viewports tower admin camp
for (const w of widths)
  shots.push({ name: `tower-admin-camp-${w}`, url: `#/tower?profile=camp&role=admin`, w });
// focus app + login + night
shots.push({ name: 'focus-app-390', url: 'focus.html', w: 390 });
shots.push({ name: 'login-390', url: 'login.html', w: 390 });
shots.push({ name: 'tower-admin-camp-night-390', url: '#/tower?profile=camp&role=admin&theme=night', w: 390 });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
for (const s of shots) {
  await page.setViewport({ width: s.w, height: 844 });
  await page.goto(BASE + '?_=' + encodeURIComponent(s.name) + s.url, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: OUT + s.name + '.png' });
  console.log('shot', s.name);
}
await browser.close();
console.log('DONE', shots.length);
