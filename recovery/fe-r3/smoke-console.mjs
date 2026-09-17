import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--disable-gpu'] });
let fail = 0;
for (const page of ['', 'focus.html', 'login.html']) {
  const p = await b.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.setViewport({ width: 390, height: 844 });
  await p.goto('http://localhost:4173/' + page, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  console.log((page || 'index'), errs.length ? 'CONSOLE-ERRORS: ' + errs.join(' | ') : 'clean');
  if (errs.length) fail = 1;
  await p.close();
}
await b.close();
process.exit(fail);
