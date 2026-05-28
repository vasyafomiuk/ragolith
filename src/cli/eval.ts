#!/usr/bin/env node
// ragolith-eval — runs a golden-set search-quality eval.
//
// Reads a JSON file of queries+expected matches, fires them at the live
// search() pipeline against the configured Weaviate, and prints a scorecard:
//
//   ragolith-eval queries.json
//   ragolith-eval queries.json --json    # pipe-friendly
//
// Exit codes:
//   0   all queries had recall >= the threshold (default 0.5)
//   1   at least one query came in below threshold
//
// JSON shape:
//   {
//     "queries": [
//       { "id": "auth", "query": "authentication flow",
//         "expect": ["src/auth.ts"], "project": "fixture" }
//     ],
//     "k": 10
//   }

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { connect } from '../core/weaviate-client.js';
import { loadConfig } from '../core/config.js';
import { loadGoldenSet, runEval, type EvalReport } from '../core/eval.js';

function colored(code: string, s: string): string {
  if (!process.stderr.isTTY || process.env['NO_COLOR']) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

function printPretty(report: EvalReport, threshold: number): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\n${colored('1', 'ragolith eval')}\n`);
  w(`  k = ${report.k}    queries = ${report.total}\n`);
  w(
    `  average recall = ${(report.averageRecall * 100).toFixed(1)}%   MRR = ${report.meanReciprocalRank.toFixed(3)}\n\n`,
  );

  for (const q of report.perQuery) {
    const ok = q.recall >= threshold;
    const flag = ok ? colored('32', '✓') : colored('31', '✗');
    const recallStr = `${(q.recall * 100).toFixed(0)}%`;
    const rrStr = q.reciprocalRank > 0 ? `rr=${q.reciprocalRank.toFixed(2)}` : 'rr=0';
    w(
      `  ${flag}  ${q.id.padEnd(28)} recall=${recallStr.padStart(4)} ${rrStr.padStart(7)}  ${colored('2', q.query)}\n`,
    );
    if (!ok) {
      // For failures, show the top-3 result files so the operator can see
      // what came back instead.
      w(`       ${colored('2', `top: ${q.topFiles.slice(0, 3).join(', ') || '(none)'}`)}\n`);
    }
  }
  w('\n');
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('ragolith-eval')
    .description('Run a golden-set search-quality eval against the live index.')
    .argument('<golden-set>', 'path to the JSON golden-set file')
    .option(
      '--threshold <n>',
      'minimum recall to count a query as passing',
      (v) => Number.parseFloat(v),
      0.5,
    )
    .option('--json', 'emit the EvalReport as JSON instead of a scorecard', false)
    .parse(process.argv);

  const opts = program.opts<{ threshold: number; json: boolean }>();
  const [goldenPath] = program.args;
  if (!goldenPath) {
    process.stderr.write('[eval] missing golden-set path argument\n');
    process.exit(2);
  }

  const cfg = loadConfig();
  const client = await connect(cfg.weaviate);
  try {
    const goldenSet = await loadGoldenSet(goldenPath);
    const report = await runEval(client, goldenSet);

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printPretty(report, opts.threshold);
    }

    const failed = report.perQuery.filter((q) => q.recall < opts.threshold).length;
    if (failed > 0) {
      process.stderr.write(
        `[eval] ${failed}/${report.total} queries below threshold ${opts.threshold}\n`,
      );
      process.exit(1);
    }
  } finally {
    await client.close();
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[eval] fatal: ${msg}\n`);
    process.exit(1);
  });
}
