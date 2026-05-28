#!/usr/bin/env node
// Enforce architectural layering between src/core, src/mcp, src/cli.
//
// Rules:
//   - core/ MUST NOT import from mcp/ or cli/
//   - mcp/  MUST NOT import from cli/
//   - cli/  MUST NOT import from mcp/
//
// In other words: `core` is the foundation, `mcp` and `cli` are sibling
// adapters that each reach into core but never into each other.
//
// Run via `npm run check:layers`. Exits non-zero on the first violation,
// so it doubles as a CI gate.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const srcRoot = join(root, 'src');

/** Layer → set of layer names it is *not* allowed to import from. */
const FORBIDDEN = {
  core: new Set(['mcp', 'cli']),
  mcp: new Set(['cli']),
  cli: new Set(['mcp']),
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && /\.ts$/.test(ent.name)) out.push(full);
  }
  return out;
}

function layerOf(absPath) {
  const rel = relative(srcRoot, absPath);
  const top = rel.split('/')[0];
  return FORBIDDEN[top] ? top : null;
}

/** Extract relative `from '...'` paths from a TS source. */
function importsFrom(source) {
  const out = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    const spec = m[1];
    if (spec.startsWith('.')) out.push(spec);
  }
  return out;
}

const violations = [];

for (const file of await walk(srcRoot)) {
  const myLayer = layerOf(file);
  if (!myLayer) continue;
  const source = await readFile(file, 'utf-8');
  for (const spec of importsFrom(source)) {
    const absImport = resolve(dirname(file), spec).replace(/\.js$/, '');
    const rel = relative(srcRoot, absImport);
    const importedLayer = rel.split('/')[0];
    if (!FORBIDDEN[importedLayer]) continue; // outside src/ — fine
    if (FORBIDDEN[myLayer].has(importedLayer)) {
      violations.push({
        file: relative(root, file),
        importedLayer,
        spec,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`Layer-boundary violations (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}  →  ${v.importedLayer}/  (\`${v.spec}\`)`);
  }
  console.error('\nSee CONTRIBUTING.md for the layering rules.');
  process.exit(1);
}

console.log('Layer check passed.');
