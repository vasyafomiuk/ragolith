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
  fetchDecompositionInputs,
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
import { decomposeProject, type DecompositionReport } from '../core/analysis/decomposition.js';

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

function printDecompositionReport(report: DecompositionReport): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\n${color(C.bold, `ragolith decomposition — ${report.project}`)}\n\n`);

  if (report.modules.length === 0) {
    w(`${color(C.dim, 'no modules found — has this project been ingested with call edges?')}\n\n`);
    return;
  }

  w(color(C.bold, 'modules (by cohesion)\n'));
  w(color(C.dim, '  module                     files  cohesion  instability  fanIn  fanOut\n'));
  for (const m of report.modules.slice(0, 25)) {
    w(
      '  ' +
        m.module.padEnd(26).slice(0, 26) +
        ' ' +
        String(m.files).padStart(5) +
        '  ' +
        m.cohesion.toFixed(2).padStart(8) +
        '  ' +
        m.instability.toFixed(2).padStart(11) +
        '  ' +
        String(m.fanIn).padStart(5) +
        '  ' +
        String(m.fanOut).padStart(6) +
        '\n',
    );
  }

  if (report.seams.length > 0) {
    w(`\n${color(C.bold, 'suggested service seams')}\n`);
    for (const s of report.seams) {
      w(
        `  ${color(C.green, '◆')} ${color(C.bold, s.module)} ${color(C.dim, `(${s.files} files)`)}\n`,
      );
      w(`      ${color(C.dim, s.rationale)}\n`);
    }
  }

  if (report.couplings.length > 0) {
    w(
      `\n${color(C.bold, 'tightest cross-module couplings')} ${color(C.dim, '(migration friction)')}\n`,
    );
    for (const c of report.couplings.slice(0, 10)) {
      w(`  ${c.calls.toString().padStart(4)} calls   ${c.a} ${color(C.dim, '↔')} ${c.b}\n`);
    }
  }

  w(
    `\n${color(C.bold, 'summary')}  ${report.totals.modules} modules  ·  ` +
      `${report.totals.crossModuleCalls} cross-module calls  ·  ${report.seams.length} seam(s)\n\n`,
  );
}

async function runDecompose(opts: {
  project?: string;
  depth?: string;
  json?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  if (!opts.project) {
    process.stderr.write('[analyze] decompose requires --project <name>\n');
    process.exitCode = 1;
    return;
  }
  const client = await connect(cfg.weaviate);
  try {
    const inputs = await fetchDecompositionInputs(client, opts.project);
    const moduleDepth = opts.depth ? Math.max(1, Number.parseInt(opts.depth, 10) || 1) : 1;
    const report = decomposeProject(opts.project, inputs, { moduleDepth });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printDecompositionReport(report);
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

program
  .command('decompose')
  .description('Suggest microservice boundaries from the module dependency graph')
  .requiredOption('--project <name>', 'Project to analyze')
  .option('--depth <n>', 'Path segments that form a module key (default 1)')
  .option('--json', 'Emit the raw DecompositionReport as JSON', false)
  .action(runDecompose);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(
    `[analyze] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
