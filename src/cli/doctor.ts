#!/usr/bin/env node
// ragolith-doctor — terminal version of the dashboard's Health view.
//
// One command that answers "is anything broken?" without needing a browser.
// Prints a coloured five-line scorecard for Weaviate HTTP, Weaviate gRPC,
// embedder module, reranker module, and the ingest state file. Pass --json
// to dump the raw HealthStatus object for piping into jq.
//
// Exit codes:
//   0   everything reachable
//   1   one or more probes failed (Weaviate not running, embedder missing, etc.)

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { health, type HealthStatus } from '../core/health.js';

function isTTY(): boolean {
  return !!process.stderr.isTTY && !process.env['NO_COLOR'];
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

function color(code: string, s: string): string {
  return isTTY() ? `${code}${s}${C.reset}` : s;
}

function dot(ok: boolean): string {
  return ok ? color(C.green, '●') : color(C.red, '●');
}

function status(ok: boolean): string {
  return ok ? color(C.green, 'OK') : color(C.red, 'FAIL');
}

function printPretty(h: HealthStatus): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\n${color(C.bold, 'ragolith doctor')}\n\n`);

  w(`  ${dot(h.weaviate.http)}  Weaviate HTTP    ${status(h.weaviate.http)}\n`);
  if (h.weaviate.error && !h.weaviate.http) {
    w(`     ${color(C.dim, h.weaviate.error)}\n`);
  }
  w(`  ${dot(h.weaviate.grpc)}  Weaviate gRPC    ${status(h.weaviate.grpc)}\n`);

  w(`  ${dot(h.embedder.reachable)}  Embedder         `);
  w(
    h.embedder.reachable
      ? color(C.green, 'text2vec-transformers loaded')
      : color(C.red, 'module not loaded'),
  );
  w('\n');
  if (h.embedder.error && !h.embedder.reachable) {
    w(`     ${color(C.dim, h.embedder.error)}\n`);
  }

  const rerankerNote = h.reranker.reachable
    ? `reranker-transformers loaded (${h.reranker.enabled ? 'used' : 'disabled in config'})`
    : h.reranker.enabled
      ? 'module not loaded'
      : 'disabled in config';
  // Reranker "ok" if the user has it disabled OR it's loaded.
  const rerankerOk = h.reranker.reachable || !h.reranker.enabled;
  w(`  ${dot(rerankerOk)}  Reranker         `);
  w(rerankerOk ? color(C.green, rerankerNote) : color(C.yellow, rerankerNote));
  w('\n');

  const stateOk = h.state.exists;
  w(`  ${dot(stateOk)}  Ingest state     `);
  if (stateOk) {
    w(color(C.green, `${h.state.projects.length} projects, ${h.state.files.length} files`));
  } else {
    w(color(C.yellow, 'not yet created — run ragolith-ingest'));
  }
  w('\n');
  w(`     ${color(C.dim, h.state.path)}\n\n`);
}

function isFatal(h: HealthStatus): boolean {
  // We consider it fatal when Weaviate isn't reachable at all OR the embedder
  // module is missing (without it, ingest can't vectorize). A missing
  // reranker is non-fatal because rerankerEnabled may be false.
  if (!h.weaviate.http || !h.weaviate.grpc) return true;
  if (!h.embedder.reachable) return true;
  return false;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('ragolith-doctor')
    .description('Probe Weaviate, the embedder, the reranker, and the ingest state file.')
    .option('--json', 'emit the raw HealthStatus object as JSON', false)
    .parse(process.argv);

  const opts = program.opts<{ json: boolean }>();
  const h = await health();

  if (opts.json) {
    process.stdout.write(JSON.stringify(h, null, 2) + '\n');
  } else {
    printPretty(h);
  }

  process.exit(isFatal(h) ? 1 : 0);
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[ragolith-doctor] fatal: ${msg}\n`);
    process.exit(1);
  });
}
