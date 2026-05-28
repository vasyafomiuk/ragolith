#!/usr/bin/env node
// Copies src/dashboard/public/* to dist/dashboard/public/* after `tsc` runs.
//
// tsc only transpiles .ts → .js; it doesn't move static assets. The dashboard
// server resolves its public/ dir relative to its own location at runtime,
// so the HTML/CSS/JS need to live next to the compiled server.js for both
// `tsx src/dashboard/server.ts` (dev) and `node dist/dashboard/server.js`
// (production) to work. The dev path is fine because public/ already sits
// next to the source; this script handles the production path.

import { cp, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const src = resolve(root, 'src/dashboard/public');
const dst = resolve(root, 'dist/dashboard/public');

await mkdir(dirname(dst), { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`Copied dashboard assets: ${src} → ${dst}`);
