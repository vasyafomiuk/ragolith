#!/usr/bin/env node
// Discover *.test.ts files under tests/ and forward them to node --test.
//
// node:test's --test flag will recursively discover .js/.mjs/.cjs by default
// but it does NOT discover .ts even when tsx is loaded via --import. So we
// list files ourselves and pass them explicitly. Portable across shells.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && /\.test\.ts$/.test(ent.name)) out.push(full);
  }
  return out;
}

const files = await walk('tests');
if (files.length === 0) {
  console.error('No test files found under tests/.');
  process.exit(1);
}

const flags = ['--import', 'tsx', '--test'];
// Pass through extra args (e.g. --watch, --test-name-pattern=foo).
const extra = process.argv.slice(2);
const child = spawn('node', [...flags, ...extra, ...files], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
