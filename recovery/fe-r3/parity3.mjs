import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:4173/';
const OUT = '/home/sandbox/release/fe-rebuild/qa/parity/';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--disable-gpu'] });
const p = await b.newPage();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (name) => { await p.screenshot({ path: OUT + name }); console.log('shot', name); };

// education vertical — canonical parity layer wired into runtime (QA correction 2 evidence)
for (const w of [360, 390, 430]) {
  await p.setViewport({ width: w, height: 844 });
  await p.goto(BASE + `?_=e${w}#/tower?profile=education&role=admin`, { waitUntil: 'networkidle0' }); await sleep(1200);
  await shot(`tower-admin-education-${w}.png`);
}
await p.setViewport({ width: 390, height: 844 });
for (const v of ['builder', 'approvals']) {
  await p.goto(BASE + `?_=e${v}#/${v}?profile=education&role=admin`, { waitUntil: 'networkidle0' }); await sleep(1200);
  await shot(`${v}-admin-education-390.png`);
}
// education focus entry
await p.goto(BASE + 'focus.html?_=ef&profile=education', { waitUntil: 'networkidle0' }); await sleep(1200);
await shot('focus-app-education-390.png');
// education end-to-end in UI: fm delay report on s1 -> approvals queue with domino rail
await p.goto(BASE + '?_=ei#/incidents?profile=education&role=field_manager', { waitUntil: 'networkidle0' }); await sleep(1200);
await p.select('#r-task', await p.evaluate(() => document.querySelectorAll('#r-task option')[1].value));
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('איחור'))?.click());
await p.type('#r-note', 'המורה מאחרת ב-30 דקות');
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'שליחת דיווח')?.click());
await sleep(1500);
await shot('incidents-submitted-fm-education-390.png');
await p.evaluate(() => [...document.querySelectorAll('.nav-tab')].find(b => b.textContent?.includes('אישורים'))?.click());
await sleep(1200);
await shot('approvals-pending-education-390.png');
await b.close(); console.log('DONE batch3');
