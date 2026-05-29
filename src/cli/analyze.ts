#!/usr/bin/env node
// ragolith-analyze — analyses over the indexed SDLC + code graph.
//
// Subcommands:
//   gaps        Traceability gaps: unimplemented requirements, untested
//               implementations, accepted-but-unbuilt decisions, orphan
//               tests, dangling links.
//
// (modernization + decomposition land as further subcommands.)
//
// Exit codes for `gaps`:
//   0   no high-severity gaps (or --strict not set)
//   2   --strict set and at least one high-severity gap found

import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import {
  connect,
  getTechStack,
  listArtifacts,
  listProjectStacks,
} from '../core/weaviate-client.js';
import { analyzeGaps, type Gap, type GapReport, type GapSeverity } from '../core/analysis/gaps.js';
import {
  analyzeModernization,
  type ModernizationReport,
  type ModernizationSeverity,
} from '../core/analysis/modernization.js';

function isTTY(): boolean {
  return !!process.stdout.isTTY && !process.env['NO_COLOR'];
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

const SEV_COLOR: Record<GapSeverity, string> = {
  high: C.red,
  warning: C.yellow,
  info: C.dim,
};

function printGapReport(report: GapReport): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\n${color(C.bold, 'ragolith gap analysis')}\n\n`);

  if (report.gaps.length === 0) {
    w(`${color(C.green, '● no gaps found')} across ${report.totals.artifacts} artifacts\n\n`);
    return;
  }

  let lastKind = '';
  for (const g of report.gaps) {
    if (g.kind !== lastKind) {
      lastKind = g.kind;
      w(`${color(C.bold, g.kind.replace(/_/g, ' '))}\n`);
    }
    const sev = color(SEV_COLOR[g.severity], g.severity.toUpperCase().padEnd(7));
    w(`  ${sev} ${color(C.bold, g.artifact_id)} ${color(C.dim, `(${g.project})`)} — ${g.title}\n`);
    w(`          ${color(C.dim, g.detail)}\n`);
  }

  w('\n');
  const c = report.counts;
  w(`${color(C.bold, 'summary')}  `);
  w(
    [
      `${c.unimplemented_requirement} unimplemented req`,
      `${c.untested_requirement} untested`,
      `${c.unimplemented_decision} unbuilt decision`,
      `${c.orphan_test} orphan test`,
      `${c.dangling_link} dangling link`,
    ].join(color(C.dim, '  ·  ')),
  );
  w(`\n  over ${report.totals.artifacts} artifacts\n\n`);
}

async function runGaps(opts: {
  project?: string;
  json?: boolean;
  strict?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const client = await connect(cfg.weaviate);
  try {
    const artifacts = await listArtifacts(client, opts.project ? { project: opts.project } : {});
    const report = analyzeGaps(artifacts);

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printGapReport(report);
    }

    if (opts.strict) {
      const highs = report.gaps.filter((g: Gap) => g.severity === 'high').length;
      if (highs > 0) {
        process.stderr.write(`[analyze] --strict: ${highs} high-severity gap(s)\n`);
        process.exitCode = 2;
      }
    }
  } finally {
    await client.close();
  }
}

const MOD_SEV_COLOR: Record<ModernizationSeverity, string> = {
  high: C.red,
  warning: C.yellow,
  info: C.dim,
};

function printModernizationReports(reports: ModernizationReport[]): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\n${color(C.bold, 'ragolith modernization analysis')}\n\n`);

  const withFindings = reports.filter((r) => r.findings.length > 0);
  if (withFindings.length === 0) {
    w(`${color(C.green, '● no modernization findings')} across ${reports.length} project(s)\n\n`);
    return;
  }

  let totHigh = 0;
  let totWarn = 0;
  let totInfo = 0;
  for (const r of reports) {
    if (r.findings.length === 0) continue;
    totHigh += r.counts.high;
    totWarn += r.counts.warning;
    totInfo += r.counts.info;
    w(`${color(C.bold, r.project)}\n`);
    for (const f of r.findings) {
      const sev = color(MOD_SEV_COLOR[f.severity], f.severity.toUpperCase().padEnd(7));
      w(`  ${sev} ${color(C.bold, f.subject)} ${color(C.dim, f.version)} — ${f.finding}\n`);
      w(`          ${color(C.dim, '→ ' + f.recommendation)}\n`);
    }
    w('\n');
  }
  w(
    `${color(C.bold, 'summary')}  ${totHigh} high  ·  ${totWarn} warning  ·  ${totInfo} info  ` +
      `across ${withFindings.length}/${reports.length} project(s)\n\n`,
  );
}

async function runModernize(opts: {
  project?: string;
  json?: boolean;
  strict?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const client = await connect(cfg.weaviate);
  try {
    let stacks;
    if (opts.project) {
      const one = await getTechStack(client, opts.project);
      stacks = one ? [one] : [];
    } else {
      stacks = await listProjectStacks(client);
    }
    const reports = stacks.map((s) => analyzeModernization(s));

    if (opts.json) {
      process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
    } else {
      printModernizationReports(reports);
    }

    if (opts.strict && reports.some((r) => r.counts.high > 0)) {
      const n = reports.reduce((acc, r) => acc + r.counts.high, 0);
      process.stderr.write(`[analyze] --strict: ${n} high-severity modernization finding(s)\n`);
      process.exitCode = 2;
    }
  } finally {
    await client.close();
  }
}

const program = new Command();
program.name('ragolith-analyze').description('Analyses over the indexed SDLC + code graph.');

program
  .command('gaps')
  .description('Find traceability gaps in the SDLC artifact graph')
  .option('--project <name>', 'Restrict analysis to one project')
  .option('--json', 'Emit the raw GapReport as JSON', false)
  .option('--strict', 'Exit non-zero (2) if any high-severity gap is found', false)
  .action(runGaps);

program
  .command('modernize')
  .description('Flag end-of-life / legacy runtimes + frameworks from the detected tech stack')
  .option('--project <name>', 'Restrict analysis to one project')
  .option('--json', 'Emit the raw reports as JSON', false)
  .option('--strict', 'Exit non-zero (2) if any high-severity finding is present', false)
  .action(runModernize);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(
    `[analyze] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
