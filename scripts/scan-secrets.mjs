#!/usr/bin/env node
/** QA-M3-4: gitleaks-style secret scan over the repo (tracked files, excluding
 *  volatile dirs). Fails the build on private keys, cloud keys, tokens, or
 *  credential assignments with real-looking values. Test fixtures (admin123
 *  hashes) and doc mentions are allowlisted by pattern, not by path. */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'twilio-auth-token-value', re: /TWILIO_AUTH_TOKEN\s*[:=]\s*["']?[0-9a-f]{32}["']?/ },
  { name: 'twilio-api-key', re: /\bSK[0-9a-f]{32}\b/ },
  { name: 'stripe-live', re: /\b(sk|pk)_live_[0-9A-Za-z]{16,}\b/ },
  { name: 'generic-bearer', re: /authorization["']?\s*[:=]\s*["']Bearer [A-Za-z0-9._-]{20,}["']/i },
  { name: 'password-literal', re: /password\s*[:=]\s*["'][^"'\s]{12,}["']/i },
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist']);
const SKIP_FILES = new Set(['scripts/scan-secrets.mjs']);

/** Works both inside the git repo (git ls-files) and on a plain extracted
 *  export (filesystem walk) — QA re-scans tarball drops, which have no .git. */
function collectFiles() {
  try {
    const files = execSync('git ls-files', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n').filter(Boolean);
    return files.map(f => [f, () => execSync(`git show :${JSON.stringify(f)}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })]);
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = `${dir}/${name}`;
        if (statSync(p).isDirectory()) walk(p);
        else out.push([p.slice(2), () => readFileSync(p, 'utf8')]);
      }
    };
    walk('.');
    return out;
  }
}

const files = collectFiles()
  .filter(([f]) => f && !f.endsWith('.sha256') && !SKIP_FILES.has(f));

let hits = 0;
for (const [file, read] of files) {
  let content;
  try { content = read(); }
  catch { continue; }
  for (const { name, re } of PATTERNS) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) { console.error(`SECRET? ${name} at ${file}:${i + 1}`); hits += 1; }
    });
  }
}
if (hits > 0) { console.error(`secret scan FAILED: ${hits} potential secret(s)`); process.exit(1); }
console.log('secret scan clean');
