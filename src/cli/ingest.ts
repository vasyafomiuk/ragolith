#!/usr/bin/env node
// Ingest CLI — drives the full pipeline:
//   1. Load config (projects + standalone files).
//   2. Clone/fetch repos via Git Manager.
//   3. Detect incremental vs full (git diff since last SHA).
//   4. Walk files respecting .gitignore + extension filters.
//   5. Dispatch to language-specific chunker.
//   6. Prepend project context prefix to chunks.
//   7. Batch insert chunks/edges into Weaviate.
//   8. Record ingested commit SHA to data.json.

import { Command } from 'commander';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
  generateUuid5,
  type DataObject,
  type WeaviateClient,
  type WeaviateField,
} from 'weaviate-client';

import { loadConfig } from '../core/config.js';
import { connect, ensureSchema, deleteFiles, deleteProject, CODE_CHUNK, SYMBOL_RECORD, CALL_EDGE } from '../core/weaviate-client.js';
import { syncRepo, changedFiles, joinRepo } from '../core/git-manager.js';
import { detectLanguage, readSourceFile } from '../core/file-reader.js';
import { applyProjectPrefix, pickChunker } from '../core/chunkers/index.js';
import type {
  ChunkResult,
  IngestState,
  ProjectConfig,
  FileConfig,
} from '../core/types.js';

// `ignore` is published as CJS with `export default ignore` in its .d.ts.
// Under module:NodeNext the default-import dance confuses TS into seeing it as
// a non-callable namespace, so reach for the package via createRequire and
// type the result locally — the actual runtime export is the callable factory.
interface IgnoreInst {
  add(patterns: string | readonly string[] | IgnoreInst): IgnoreInst;
  ignores(pathname: string): boolean;
}
const ignoreRequire = createRequire(import.meta.url);
const ignore: () => IgnoreInst = ignoreRequire('ignore');

const BATCH_SIZE = 200;

async function loadGitignore(root: string): Promise<IgnoreInst> {
  const ig = ignore();
  // Always ignore VCS and node_modules — even when no .gitignore exists.
  ig.add(['.git/', 'node_modules/', 'dist/', 'build/', '.DS_Store']);
  const gi = join(root, '.gitignore');
  if (existsSync(gi)) ig.add((await readFile(gi, 'utf-8')).split('\n'));
  return ig;
}

async function walk(
  root: string,
  extensions: Set<string>,
  ig: IgnoreInst,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      const checkPath = ent.isDirectory() ? `${rel}/` : rel;
      if (ig.ignores(checkPath)) continue;
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && extensions.has(extname(ent.name).toLowerCase())) out.push(full);
    }
  }
  return out;
}

async function loadState(path: string): Promise<IngestState> {
  if (!existsSync(path)) return { projects: {}, files: {} };
  return JSON.parse(await readFile(path, 'utf-8')) as IngestState;
}

async function saveState(path: string, state: IngestState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

interface BatchBuffers {
  chunks: ChunkResult['chunks'];
  symbols: ChunkResult['symbols'];
  edges: ChunkResult['edges'];
}

async function flushBatches(
  client: WeaviateClient,
  buffers: BatchBuffers,
): Promise<void> {
  // Our domain types are flat primitive maps that the SDK happily accepts at
  // runtime, but its strict NonReferenceInputs<T> mapped type wants an explicit
  // index signature. Cast at the boundary — the shape is correct and stays
  // out of our domain types.
  const asProps = <T extends object>(x: T): Record<string, WeaviateField> =>
    x as unknown as Record<string, WeaviateField>;

  if (buffers.chunks.length > 0) {
    const col = client.collections.get(CODE_CHUNK);
    const objs: DataObject<undefined>[] = buffers.chunks.map((c) => ({
      properties: asProps(c),
      id: generateUuid5(`${c.project}::${c.file_path}::${c.start_line}-${c.end_line}::${c.symbol ?? ''}`),
    }));
    await col.data.insertMany(objs);
    buffers.chunks.length = 0;
  }
  if (buffers.symbols.length > 0) {
    const col = client.collections.get(SYMBOL_RECORD);
    const objs: DataObject<undefined>[] = buffers.symbols.map((s) => ({
      properties: asProps(s),
      id: generateUuid5(`${s.project}::${s.file_path}::${s.kind}::${s.parent ?? ''}::${s.name}::${s.start_line}`),
    }));
    await col.data.insertMany(objs);
    buffers.symbols.length = 0;
  }
  if (buffers.edges.length > 0) {
    const col = client.collections.get(CALL_EDGE);
    const objs: DataObject<undefined>[] = buffers.edges.map((e) => ({
      properties: asProps(e),
      id: generateUuid5(`${e.project}::${e.file}::${e.line}::${e.caller}->${e.callee}`),
    }));
    await col.data.insertMany(objs);
    buffers.edges.length = 0;
  }
}

async function ingestFiles(
  client: WeaviateClient,
  project: string,
  fileRoots: { absPath: string; storedPath: string }[],
  buffers: BatchBuffers,
  maxBytes: number,
  commitSha: string | undefined,
): Promise<{ processed: number; skipped: number }> {
  let processed = 0;
  let skipped = 0;
  for (const { absPath, storedPath } of fileRoots) {
    const language = detectLanguage(absPath);
    if (language === 'unknown') { skipped++; continue; }
    const result = await readSourceFile(absPath, maxBytes);
    if (!result) { skipped++; continue; }
    const chunked = pickChunker({
      content: result.content,
      filePath: storedPath,
      project,
      language: result.language,
    });
    if (commitSha) chunked.chunks.forEach((c) => { c.commit_sha = commitSha; });
    const prefixed = applyProjectPrefix(chunked, project);
    buffers.chunks.push(...prefixed.chunks);
    buffers.symbols.push(...prefixed.symbols);
    buffers.edges.push(...prefixed.edges);
    processed++;
    if (buffers.chunks.length >= BATCH_SIZE
        || buffers.symbols.length >= BATCH_SIZE
        || buffers.edges.length >= BATCH_SIZE) {
      await flushBatches(client, buffers);
    }
  }
  return { processed, skipped };
}

async function ingestProject(
  client: WeaviateClient,
  project: ProjectConfig,
  state: IngestState,
  workDir: string,
  extensions: Set<string>,
  maxBytes: number,
  forceFull: boolean,
): Promise<void> {
  process.stderr.write(`[ingest] project: ${project.name}\n`);
  const handle = await syncRepo(workDir, project);
  const previous = state.projects[project.name];
  const incremental = !forceFull && previous?.commit_sha && previous.commit_sha !== handle.head;

  const buffers: BatchBuffers = { chunks: [], symbols: [], edges: [] };
  const subPaths = (project.subPaths && project.subPaths.length > 0) ? project.subPaths : [''];

  if (incremental && previous) {
    const { added, deleted } = await changedFiles(handle.path, previous.commit_sha);
    const inSubpaths = (p: string): boolean =>
      subPaths.some((s) => s === '' || p === s || p.startsWith(s.endsWith('/') ? s : `${s}/`));
    const addedFiltered = added.filter(inSubpaths).filter((p) => extensions.has(extname(p).toLowerCase()));
    const deletedFiltered = deleted.filter(inSubpaths);

    process.stderr.write(`[ingest]   incremental: +${addedFiltered.length} ~${deletedFiltered.length}\n`);
    if (deletedFiltered.length + addedFiltered.length > 0) {
      await deleteFiles(client, project.name, [...deletedFiltered, ...addedFiltered]);
    }
    const fileRoots = addedFiltered.map((p) => ({
      absPath: joinRepo(handle.path, p),
      storedPath: p,
    }));
    await ingestFiles(client, project.name, fileRoots, buffers, maxBytes, handle.head);
  } else {
    if (previous) {
      process.stderr.write('[ingest]   full rebuild (forced or first run)\n');
      await deleteProject(client, project.name);
    }
    for (const sub of subPaths) {
      const root = sub ? join(handle.path, sub) : handle.path;
      if (!existsSync(root)) continue;
      const ig = await loadGitignore(handle.path);
      const files = await walk(root, extensions, ig);
      const fileRoots = files.map((abs) => ({
        absPath: abs,
        storedPath: relative(handle.path, abs),
      }));
      process.stderr.write(`[ingest]   ${sub || '.'}: ${files.length} files\n`);
      await ingestFiles(client, project.name, fileRoots, buffers, maxBytes, handle.head);
    }
  }

  await flushBatches(client, buffers);
  state.projects[project.name] = {
    commit_sha: handle.head,
    updated_at: new Date().toISOString(),
  };
}

async function ingestStandalone(
  client: WeaviateClient,
  file: FileConfig,
  state: IngestState,
  maxBytes: number,
): Promise<void> {
  process.stderr.write(`[ingest] file: ${file.name} (${file.path})\n`);
  const st = await stat(file.path);
  const previous = state.files[file.name];
  if (previous && previous.mtime_ms === st.mtimeMs) {
    process.stderr.write('[ingest]   up-to-date, skipping\n');
    return;
  }
  // Re-ingest: remove existing chunks under this synthetic project name.
  await deleteProject(client, file.name);

  const buffers: BatchBuffers = { chunks: [], symbols: [], edges: [] };
  await ingestFiles(
    client,
    file.name,
    [{ absPath: resolve(file.path), storedPath: file.path }],
    buffers,
    maxBytes,
    undefined,
  );
  await flushBatches(client, buffers);

  state.files[file.name] = {
    mtime_ms: st.mtimeMs,
    updated_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('ragolith-ingest')
    .description('Ingest configured projects and files into Weaviate')
    .option('--full', 'Force a full rebuild (delete + re-ingest all projects)', false)
    .option('--project <name>', 'Restrict to one project name')
    .option('--file <name>', 'Restrict to one standalone file entry')
    .parse(process.argv);

  const opts = program.opts<{ full: boolean; project?: string; file?: string }>();
  const cfg = loadConfig();

  const client = await connect(cfg.weaviate);
  await ensureSchema(client);

  const stateFile = resolve(cfg.ingest.stateFile);
  const state = await loadState(stateFile);
  const extensions = new Set(cfg.ingest.extensions.map((e) => e.toLowerCase()));

  const projects = opts.project
    ? cfg.projects.filter((p) => p.name === opts.project)
    : cfg.projects;
  const files = opts.file
    ? cfg.files.filter((f) => f.name === opts.file)
    : cfg.files;

  // Ensure the workDir exists before any clone attempts.
  await mkdir(resolve(cfg.ingest.workDir), { recursive: true });
  for (const project of projects) {
    try {
      await ingestProject(
        client,
        project,
        state,
        resolve(cfg.ingest.workDir),
        extensions,
        cfg.ingest.maxFileBytes,
        opts.full,
      );
      // Persist after each project so a crash doesn't lose all progress.
      await saveState(stateFile, state);
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`[ingest] project "${project.name}" failed: ${msg}\n`);
    }
  }

  for (const file of files) {
    try {
      await ingestStandalone(client, file, state, cfg.ingest.maxFileBytes);
      await saveState(stateFile, state);
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`[ingest] file "${file.name}" failed: ${msg}\n`);
    }
  }

  process.stderr.write('[ingest] done\n');
  await client.close();
}

// Removed import.meta-aware guard: this file is always invoked as the entrypoint
// (npm run ingest, or via the bin). Run unconditionally.
main().catch((err) => {
  process.stderr.write(`[ingest] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
