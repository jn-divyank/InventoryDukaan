#!/usr/bin/env node
/* Runs every suite in its own process and reports a combined result.
 *
 *   node tests/run-all.mjs              # local suites only
 *   node tests/run-all.mjs --all        # including the ones that need network
 *   node tests/run-all.mjs 05           # just the suites matching "05"
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NETWORKED = new Set(['08-sync-and-rls.test.mjs', '09-live-smoke.test.mjs']);

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const filters = args.filter(a => !a.startsWith('--'));

const files = (await readdir(HERE))
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .filter(f => (filters.length ? filters.some(x => f.includes(x)) : true))
  .filter(f => (wantAll || filters.length ? true : !NETWORKED.has(f)));

if (!files.length) {
  console.error('no suites matched');
  process.exit(1);
}

const needsCreds = files.some(f => f === '08-sync-and-rls.test.mjs');
if (needsCreds && !(process.env.E2E_EMAIL && process.env.E2E_PASSWORD)) {
  console.error('\n08-sync-and-rls needs E2E_EMAIL and E2E_PASSWORD (the dedicated test\n' +
                'account, not the shop login). See tests/README.md.\n');
  process.exit(1);
}

const run = file => new Promise(resolve => {
  const started = Date.now();
  const proc = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
  proc.on('exit', code => resolve({ file, code, ms: Date.now() - started }));
});

console.log(`running ${files.length} suite(s)\n`);
const results = [];
for (const f of files) {
  console.log(`\n${'='.repeat(64)}\n  ${f}\n${'='.repeat(64)}`);
  results.push(await run(f));
}

console.log(`\n${'='.repeat(64)}\n  SUMMARY\n${'='.repeat(64)}`);
let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? 'ok  ' : 'FAIL';
  if (r.code !== 0) failed++;
  console.log(`  ${mark}  ${r.file.padEnd(32)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(`\n${results.length - failed}/${results.length} suites passed`);
if (!wantAll && !filters.length) {
  console.log('(networked suites skipped — pass --all to include them)');
}
process.exit(failed ? 1 : 0);
