// Asset smoke (QA stop-ship correction 3b, 2026-09-17): validate required assets by
// HTTP status + MIME + non-empty body (+ wOF2 magic for fonts), not console only.
// Usage: node smoke-assets.mjs  (expects `vite preview` on :4173, run against dist/)
const BASE = process.env.SMOKE_BASE || 'http://localhost:4173';
let fail = 0;
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' — ' + detail}`); if (!cond) fail = 1; };
async function get(path) { const r = await fetch(BASE + path); return { status: r.status, mime: (r.headers.get('content-type') || '').split(';')[0], body: Buffer.from(await r.arrayBuffer()) }; }

const entries = ['/', '/focus.html', '/login.html'];
const assetUrls = new Set();
for (const e of entries) {
  const r = await get(e);
  ok(`${e} html`, r.status === 200 && r.mime === 'text/html' && r.body.length > 500, `status=${r.status} mime=${r.mime} bytes=${r.body.length}`);
  for (const m of r.body.toString('utf8').matchAll(/(?:src|href)="(\.?\/assets\/[^"]+)"/g)) assetUrls.add(m[1].replace(/^\./, ''));
}
for (const a of assetUrls) {
  if (a.startsWith('/fonts/')) continue; // dedicated font check below (MIME + wOF2 magic)
  const r = await get(a);
  const want = a.endsWith('.css') ? 'text/css' : /javascript/;
  ok(`${a}`, r.status === 200 && (typeof want === 'string' ? r.mime === want : want.test(r.mime)) && r.body.length > 100, `status=${r.status} mime=${r.mime} bytes=${r.body.length}`);
  if (a.endsWith('.css')) {
    for (const m of r.body.toString('utf8').matchAll(/url\(\.\.\/(fonts\/[^)]+)\)/g)) assetUrls.add('/' + m[1]);
  }
}
for (const a of [...assetUrls].filter((x) => x.startsWith('/fonts/'))) {
  const r = await get(a);
  ok(`${a}`, r.status === 200 && r.mime === 'font/woff2' && r.body.subarray(0, 4).toString() === 'wOF2', `status=${r.status} mime=${r.mime} magic=${r.body.subarray(0, 4)}`);
}
for (const [p, want] of [['/brand/contake-favicon.svg', 'image/svg+xml'], ['/sw-push.js', /javascript/]]) {
  const r = await get(p);
  ok(p, r.status === 200 && (typeof want === 'string' ? r.mime === want : want.test(r.mime)) && r.body.length > 10, `status=${r.status} mime=${r.mime} bytes=${r.body.length}`);
}
console.log(fail ? 'ASSET-SMOKE FAIL' : 'ASSET-SMOKE PASS');
process.exit(fail);
