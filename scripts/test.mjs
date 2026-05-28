#!/usr/bin/env node
// Discover *.test.ts files under tests/ and forward them to node --test.
//
// node:test's --test flag will recursively discover .js/.mjs/.cjs by default
// but it does NOT discover .ts even when tsx is loaded via --import. So we
// list files ourselves and pass them explicitly. Portable across shells.
//
// Default mode skips tests/integration/ — those need a running Weaviate and
// are gated behind `npm run test:integration` so contributors without Docker
// can still hack on the codebase.
//
// Usage:
//   node scripts/test.mjs                  → unit tests only
//   node scripts/test.mjs --integration    → integration tests only
//   node scripts/test.mjs --all            → both
//   node scripts/test.mjs --watch          → unit tests in watch mode
// Any other flag is forwarded to `node --test` as-is.

import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = args.includes('--integration')
  ? 'integration'
  : args.includes('--all')
    ? 'all'
    : 'unit';
const passthrough = args.filter((a) => !['--integration', '--all'].includes(a));

const INTEGRATION_SEGMENT = `${sep}integration${sep}`;

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && /\.test\.ts$/.test(ent.name)) out.push(full);
  }
  return out;
}

const all = await walk('tests');
const files = all.filter((f) => {
  const isIntegration = f.includes(INTEGRATION_SEGMENT);
  if (mode === 'unit') return !isIntegration;
  if (mode === 'integration') return isIntegration;
  return true; // mode === 'all'
});

if (files.length === 0) {
  console.error(`No ${mode} test files found.`);
  process.exit(1);
}

const flags = ['--import', 'tsx', '--test'];
const child = spawn('node', [...flags, ...passthrough, ...files], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
