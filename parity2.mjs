import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:4173/';
const OUT = '/home/sandbox/release/fe-rebuild/qa/parity/';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--disable-gpu'] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1. focus happy path -> confirm state
await p.goto(BASE + 'focus.html?_=f1', { waitUntil: 'networkidle0' }); await sleep(1200);
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('הכל תקין'))?.click());
await sleep(1500);
await p.screenshot({ path: OUT + 'focus-confirm-390.png' });

// 2. focus offline -> error state
await p.goto(BASE + 'focus.html?_=f2&offline=1', { waitUntil: 'networkidle0' }); await sleep(1200);
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('הכל תקין'))?.click());
await sleep(1500);
await p.screenshot({ path: OUT + 'focus-offline-error-390.png' });

// 3. incident report (field_manager) -> approvals pending -> second report -> stale evidence
await p.goto(BASE + '?_=i1#/incidents?profile=camp&role=field_manager', { waitUntil: 'networkidle0' }); await sleep(1200);
await p.select('#r-task', await p.evaluate(() => document.querySelectorAll('#r-task option')[1].value));
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('איחור'))?.click());
await p.type('#r-note', 'האוטובוס תקוע בכביש 6');
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'שליחת דיווח')?.click());
await sleep(1500);
await p.screenshot({ path: OUT + 'incidents-submitted-fm-390.png' });
// second report on another task -> advances graph version (staleness setup)
await p.select('#r-task', await p.evaluate(() => document.querySelectorAll('#r-task option')[2].value));
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'שליחת דיווח')?.click());
await sleep(1500);
// switch to approvals tab (no reload: SPA state persists)
await p.evaluate(() => [...document.querySelectorAll('.nav-tab')].find(b => b.textContent?.includes('אישורים'))?.click());
await sleep(1200);
await p.screenshot({ path: OUT + 'approvals-pending-stale-390.png' });

// 4. LTR probe (evidence of recovered RTL-only behavior)
await p.goto(BASE + '?_=l1#/tower?profile=camp&role=admin', { waitUntil: 'networkidle0' }); await sleep(1000);
await p.evaluate(() => { document.documentElement.dir = 'ltr'; document.documentElement.lang = 'en'; });
await sleep(400);
await p.screenshot({ path: OUT + 'tower-ltr-probe-390.png' });

// 5. focus night
await p.goto(BASE + 'focus.html?_=f3&theme=night', { waitUntil: 'networkidle0' }); await sleep(1200);
await p.screenshot({ path: OUT + 'focus-night-390.png' });

await b.close(); console.log('DONE batch2');
