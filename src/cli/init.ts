#!/usr/bin/env node
// ragolith-init — interactive setup wizard.
//
// Walks the user through creating a ragc.config.json without needing to read
// the example file. Supports `--yes` for scripted/CI use, in which case the
// wizard skips prompts and produces a default config (Weaviate on localhost,
// no projects, no files — just enough that subsequent commands work).
//
// Pure config-building (defaultAnswers, buildConfig) is exported so the unit
// tests can exercise it without spawning a child process or mocking readline.

import { Command } from 'commander';
import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resetConfigCache } from '../core/config.js';
import type {
  BackupConfig,
  DocumentConfig,
  IngestConfig,
  RagolithConfig,
  RepoConfig,
  SearchConfig,
  WeaviateConnConfig,
} from '../core/types.js';

// --- types ----------------------------------------------------------------

export interface WizardAnswers {
  weaviate: WeaviateConnConfig;
  ingest: IngestConfig;
  search: SearchConfig;
  repos: RepoConfig[];
  documents: DocumentConfig[];
  backup: BackupConfig;
}

// --- defaults -------------------------------------------------------------

const DEFAULT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.cs',
  '.sql',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.md',
  '.mdx',
  '.txt',
  '.pdf',
  '.docx',
];

export function defaultAnswers(): WizardAnswers {
  return {
    weaviate: {
      host: 'localhost',
      httpPort: 8080,
      grpcPort: 50051,
      secure: false,
    },
    ingest: {
      workDir: '.ragolith/repos',
      stateFile: '.ragolith/data.json',
      extensions: [...DEFAULT_EXTENSIONS],
      maxFileBytes: 1_048_576,
    },
    search: {
      overFetch: 2,
      diversityPerFile: 3,
      rerankerEnabled: true,
    },
    repos: [],
    documents: [],
    backup: { backend: 'filesystem' },
  };
}

/** Produces a final RagolithConfig from gathered answers. Pure. */
export function buildConfig(answers: WizardAnswers): RagolithConfig {
  return {
    weaviate: answers.weaviate,
    ingest: answers.ingest,
    search: answers.search,
    repos: answers.repos,
    documents: answers.documents,
    backup: answers.backup,
  };
}

// --- prompt helpers -------------------------------------------------------

async function ask(rl: Interface, prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer === '' ? (defaultValue ?? '') : answer;
}

async function askYesNo(rl: Interface, prompt: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${prompt} [${hint}]: `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

async function askInt(rl: Interface, prompt: string, defaultValue: number): Promise<number> {
  for (;;) {
    const raw = await ask(rl, prompt, String(defaultValue));
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65_536) return n;
    process.stderr.write(`  expected a positive integer (got "${raw}")\n`);
  }
}

// --- interactive flow -----------------------------------------------------

async function runWizard(rl: Interface): Promise<WizardAnswers> {
  const answers = defaultAnswers();

  process.stderr.write('\nWeaviate connection (press Enter to accept the default):\n');
  answers.weaviate.host = await ask(rl, '  Host', answers.weaviate.host);
  answers.weaviate.httpPort = await askInt(rl, '  HTTP port', answers.weaviate.httpPort);
  answers.weaviate.grpcPort = await askInt(rl, '  gRPC port', answers.weaviate.grpcPort);
  answers.weaviate.secure = await askYesNo(rl, '  Use TLS (https)?', answers.weaviate.secure);

  process.stderr.write('\nRepositories to index (leave name blank to stop):\n');
  for (let i = 1; ; i++) {
    const name = await ask(rl, `  Repo ${i} name (blank to finish)`);
    if (!name) break;
    const useLocal = await askYesNo(rl, '    Use a local path (instead of a git URL)?', false);
    const repo: RepoConfig = { name };
    if (useLocal) {
      repo.localPath = resolve(await ask(rl, '    Local path'));
    } else {
      repo.repo = await ask(rl, '    Git repo URL');
      repo.branch = await ask(rl, '    Branch', 'main');
      const tokenEnv = await ask(rl, '    Token env var (blank for none, default GIT_TOKEN)');
      if (tokenEnv) repo.tokenEnv = tokenEnv;
    }
    const subPaths = await ask(
      rl,
      '    Sub-paths to index (comma-separated, blank for whole repo)',
    );
    if (subPaths) {
      repo.subPaths = subPaths
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    answers.repos.push(repo);
  }

  process.stderr.write('\nDocuments (PDF/DOCX/TXT — leave name blank to stop):\n');
  for (let i = 1; ; i++) {
    const name = await ask(rl, `  Document ${i} name (blank to finish)`);
    if (!name) break;
    const path = resolve(await ask(rl, '    Absolute path'));
    answers.documents.push({ name, path });
  }

  process.stderr.write('\nSearch:\n');
  answers.search.rerankerEnabled = await askYesNo(
    rl,
    '  Enable the cross-encoder reranker?',
    answers.search.rerankerEnabled,
  );

  return answers;
}

// --- file output ----------------------------------------------------------

async function writeConfig(path: string, config: RagolithConfig): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Write to a tmp file then rename — atomic, no half-written config if we crash mid-write.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
}

// --- entry point ----------------------------------------------------------

interface InitOptions {
  output: string;
  yes: boolean;
  force: boolean;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('ragolith-init')
    .description('Interactive setup wizard for ragolith. Creates a ragc.config.json.')
    .option('-o, --output <path>', 'where to write the config', 'ragc.config.json')
    .option('-y, --yes', 'accept all defaults, skip prompts (for scripted use)', false)
    .option('-f, --force', 'overwrite an existing config without confirmation', false)
    .parse(process.argv);

  const opts = program.opts<InitOptions>();
  const outputPath = resolve(opts.output);

  if (existsSync(outputPath) && !opts.force) {
    if (opts.yes) {
      process.stderr.write(
        `[ragolith-init] ${outputPath} already exists. Re-run with --force to overwrite.\n`,
      );
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = await askYesNo(rl, `${outputPath} exists. Overwrite?`, false);
    rl.close();
    if (!ok) {
      process.stderr.write('[ragolith-init] aborted, nothing written.\n');
      process.exit(0);
    }
  }

  let answers: WizardAnswers;
  if (opts.yes) {
    answers = defaultAnswers();
  } else {
    process.stderr.write("[ragolith-init] let's set up your ragolith config.\n");
    process.stderr.write('  (press Enter to accept each default, Ctrl-C to abort)\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-C in readline emits SIGINT on the rl interface; turn it into a clean exit.
    rl.on('SIGINT', () => {
      process.stderr.write('\n[ragolith-init] aborted, nothing written.\n');
      rl.close();
      process.exit(130);
    });
    try {
      answers = await runWizard(rl);
    } finally {
      rl.close();
    }
  }

  const config = buildConfig(answers);
  await writeConfig(outputPath, config);

  // Round-trip the file through loadConfig so we surface any merge errors here
  // rather than at first ingest. Stash + restore the cache to avoid leaking
  // wizard state into other processes that import this module.
  const prev = process.env['RAGOLITH_CONFIG'];
  process.env['RAGOLITH_CONFIG'] = outputPath;
  resetConfigCache();
  loadConfig();
  if (prev === undefined) delete process.env['RAGOLITH_CONFIG'];
  else process.env['RAGOLITH_CONFIG'] = prev;
  resetConfigCache();

  process.stderr.write(`\n[ragolith-init] wrote ${outputPath}\n`);
  process.stderr.write(`  repos:     ${answers.repos.length}\n`);
  process.stderr.write(`  documents: ${answers.documents.length}\n`);
  process.stderr.write('\nNext:\n');
  process.stderr.write('  1. docker compose up -d            # start Weaviate + embedder\n');
  process.stderr.write('  2. ragolith-ingest                 # populate the index\n');
  process.stderr.write('  3. ragolith-dashboard --open       # browse what got indexed\n');
}

// Only run the wizard when this file is the entry point — importing it from
// a test (which we do for unit testing buildConfig/defaultAnswers) must not
// start interactive prompts. Compare argv[1] against this module's path.
const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[ragolith-init] fatal: ${msg}\n`);
    process.exit(1);
  });
}
