// JSON API handlers for the dashboard.
//
// Three endpoints make up the MVP:
//   - GET  /api/health    → connection + readiness status of Weaviate + state file
//   - GET  /api/projects  → indexed projects with file/chunk counts
//   - POST /api/search    → hybrid search results, same pipeline the MCP server uses
//
// All handlers degrade gracefully — if Weaviate is unreachable, /api/health
// reports it and the other endpoints return an empty result rather than 500.

import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WeaviateClient } from 'weaviate-client';
import { configFilePath, loadConfig, resetConfigCache } from '../core/config.js';
import {
  connect,
  fetchDecompositionInputs,
  getTechStack,
  listArtifacts,
  listProjectStacks,
  CODE_CHUNK,
} from '../core/weaviate-client.js';
import { search, searchArtifacts } from '../core/search.js';
import { analyzeGaps, type GapReport } from '../core/analysis/gaps.js';
import { analyzeModernization, type ModernizationReport } from '../core/analysis/modernization.js';
import { decomposeProject, type DecompositionReport } from '../core/analysis/decomposition.js';
import { health as coreHealth, type HealthStatus } from '../core/health.js';
import { loadRegistry, type SnapshotRecord } from '../core/backups-registry.js';
import type {
  ArtifactHit,
  IngestState,
  Language,
  RagolithConfig,
  SdlcArtifact,
  SdlcArtifactKind,
  SearchHit,
} from '../core/types.js';

export type { HealthStatus };

export interface ProjectSummary {
  name: string;
  source: 'project' | 'file';
  commit_sha?: string;
  updated_at?: string;
  chunk_count: number;
  file_count: number;
  languages: Record<string, number>;
}

let cachedClient: WeaviateClient | undefined;

/** Lazily connect; cache the client so we don't reopen on every request. */
async function getClient(): Promise<WeaviateClient | undefined> {
  if (cachedClient) return cachedClient;
  try {
    const cfg = loadConfig();
    cachedClient = await connect(cfg.weaviate);
    return cachedClient;
  } catch {
    return undefined;
  }
}

function loadState(): IngestState {
  const cfg = loadConfig();
  const path = resolve(cfg.ingest.stateFile);
  if (!existsSync(path)) return { projects: {}, files: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as IngestState;
  } catch {
    return { projects: {}, files: {} };
  }
}

export async function health(): Promise<HealthStatus> {
  // Thin re-export so the existing dashboard route signature stays stable.
  return coreHealth();
}

export async function projects(): Promise<ProjectSummary[]> {
  const state = loadState();
  const client = await getClient();
  const summaries = new Map<string, ProjectSummary>();

  // Seed from the state file so we always show a row even if the Weaviate
  // collection is empty for a known project.
  for (const [name, meta] of Object.entries(state.projects)) {
    summaries.set(name, {
      name,
      source: 'project',
      commit_sha: meta.commit_sha,
      updated_at: meta.updated_at,
      chunk_count: 0,
      file_count: 0,
      languages: {},
    });
  }
  for (const [name, meta] of Object.entries(state.files)) {
    summaries.set(name, {
      name,
      source: 'file',
      updated_at: meta.updated_at,
      chunk_count: 0,
      file_count: 0,
      languages: {},
    });
  }

  // Enrich with live Weaviate counts when reachable. We compute chunk
  // count, file count, and language breakdown from a single fetchObjects
  // pass — the per-collection aggregate API in weaviate-client v3 has a
  // groupBy variant but it's awkwardly typed; one client-side fold is
  // simpler and plenty fast for a dashboard.
  if (client) {
    const col = client.collections.get(CODE_CHUNK);
    try {
      const all = await col.query.fetchObjects({
        limit: 5000,
        returnProperties: ['project', 'file_path', 'language'],
      });
      const filesByProject = new Map<string, Set<string>>();
      for (const obj of all.objects) {
        const p = obj.properties as Record<string, unknown>;
        const project = String(p['project'] ?? '');
        const filePath = String(p['file_path'] ?? '');
        const language = String(p['language'] ?? 'unknown');

        let summary = summaries.get(project);
        if (!summary) {
          summary = {
            name: project,
            source: 'project',
            chunk_count: 0,
            file_count: 0,
            languages: {},
          };
          summaries.set(project, summary);
        }
        summary.chunk_count++;
        summary.languages[language] = (summary.languages[language] ?? 0) + 1;

        if (!filesByProject.has(project)) filesByProject.set(project, new Set());
        // Just set on the line above; .get() can't be undefined here.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        filesByProject.get(project)!.add(filePath);
      }
      for (const [project, files] of filesByProject) {
        const summary = summaries.get(project);
        if (summary) summary.file_count = files.size;
      }
    } catch {
      // Weaviate unreachable mid-flight — fall through with state-file data.
    }
  }

  return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface SearchRequest {
  query: string;
  limit?: number;
  project?: string;
  language?: Language;
}

export async function runSearch(req: SearchRequest): Promise<SearchHit[]> {
  const cfg = loadConfig();
  const client = await getClient();
  if (!client) return [];

  return search(client, {
    query: req.query,
    limit: req.limit ?? 20,
    ...(req.project ? { project: req.project } : {}),
    ...(req.language ? { language: req.language } : {}),
    overFetch: cfg.search.overFetch,
    diversityPerFile: cfg.search.diversityPerFile,
    rerankerEnabled: cfg.search.rerankerEnabled,
  });
}

// --- SDLC artifacts + analysis --------------------------------------------

export interface SdlcSearchRequest {
  query: string;
  limit?: number;
  project?: string;
  source?: string;
  kind?: SdlcArtifactKind;
}

export async function runSdlcSearch(req: SdlcSearchRequest): Promise<ArtifactHit[]> {
  const cfg = loadConfig();
  const client = await getClient();
  if (!client) return [];
  return searchArtifacts(client, {
    query: req.query,
    limit: req.limit ?? 20,
    ...(req.project ? { project: req.project } : {}),
    ...(req.source ? { source: req.source } : {}),
    ...(req.kind ? { kind: req.kind } : {}),
    rerankerEnabled: cfg.search.rerankerEnabled,
  });
}

/** Lightweight artifact inventory for the SDLC view's list mode. */
export async function sdlcArtifacts(filter: {
  project?: string;
  kind?: string;
  status?: string;
}): Promise<SdlcArtifact[]> {
  const client = await getClient();
  if (!client) return [];
  return listArtifacts(client, filter);
}

export async function gapAnalysis(project?: string): Promise<GapReport> {
  const client = await getClient();
  if (!client) return { gaps: [], counts: emptyGapCounts(), totals: { artifacts: 0, byKind: {} } };
  const artifacts = await listArtifacts(client, project ? { project } : {});
  return analyzeGaps(artifacts);
}

function emptyGapCounts(): GapReport['counts'] {
  return {
    unimplemented_requirement: 0,
    untested_requirement: 0,
    unimplemented_decision: 0,
    orphan_test: 0,
    dangling_link: 0,
  };
}

export async function modernizationAnalysis(project?: string): Promise<ModernizationReport[]> {
  const client = await getClient();
  if (!client) return [];
  const stacks = project
    ? await (async () => {
        const s = await getTechStack(client, project);
        return s ? [s] : [];
      })()
    : await listProjectStacks(client);
  return stacks.map((s) => analyzeModernization(s));
}

export async function decompositionAnalysis(
  project: string,
  depth?: number,
): Promise<DecompositionReport | { error: string }> {
  const client = await getClient();
  if (!client) return { error: 'Weaviate unreachable' };
  const inputs = await fetchDecompositionInputs(client, project);
  return decomposeProject(project, inputs, { moduleDepth: depth ?? 1 });
}

export interface DeleteProjectResult {
  /** Number of chunks Weaviate confirmed it deleted. */
  deletedChunks: number;
  /** Number of chunks the filter matched (>= deletedChunks if some failed). */
  matchedChunks: number;
  /** Which entry in the ingest state file we removed, if any. */
  removedFromState: 'project' | 'file' | 'none';
}

/**
 * Drop every chunk for a project from Weaviate's CodeChunk collection, and
 * remove the project's entry from the ingest state file. We deliberately do
 * NOT touch ragc.config.json — if the project is still listed there, the next
 * ragolith-ingest will pick it back up. Repo on disk is untouched too.
 */
export async function deleteProject(name: string): Promise<DeleteProjectResult> {
  const client = await getClient();
  if (!client) {
    throw new Error('Weaviate is unreachable; cannot delete chunks');
  }

  const col = client.collections.get(CODE_CHUNK);
  // deleteMany takes a filter and returns counts. It batches internally so a
  // project with tens of thousands of chunks is handled in one call.
  const result = await col.data.deleteMany(col.filter.byProperty('project').equal(name));

  // State file is small; read, mutate, write atomically.
  const cfg = loadConfig();
  const path = resolve(cfg.ingest.stateFile);
  let state: IngestState = { projects: {}, files: {} };
  let removed: DeleteProjectResult['removedFromState'] = 'none';
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, 'utf-8')) as IngestState;
    } catch {
      // Corrupt state file — fall through with a fresh shape so we don't
      // overwrite a recoverable file. Actually: we DO want to overwrite,
      // because reading failed. Restore-from-corrupt isn't our job here.
      state = { projects: {}, files: {} };
    }
    if (state.projects?.[name]) {
      delete state.projects[name];
      removed = 'project';
    } else if (state.files?.[name]) {
      delete state.files[name];
      removed = 'file';
    }
    if (removed !== 'none') {
      const dir = dirname(path);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
      await rename(tmp, path);
    }
  }

  return {
    deletedChunks: result.successful ?? 0,
    matchedChunks: result.matches ?? 0,
    removedFromState: removed,
  };
}

/** Per-project file list with chunk counts — used by the project detail view. */
export async function projectFiles(
  projectName: string,
): Promise<{ file_path: string; language: string; chunk_count: number }[]> {
  const client = await getClient();
  if (!client) return [];

  const col = client.collections.get(CODE_CHUNK);
  const all = await col.query.fetchObjects({
    filters: col.filter.byProperty('project').equal(projectName),
    limit: 5000,
    returnProperties: ['file_path', 'language'],
  });

  const counts = new Map<string, { language: string; chunk_count: number }>();
  for (const obj of all.objects) {
    const p = obj.properties as Record<string, unknown>;
    const filePath = String(p['file_path'] ?? '');
    const language = String(p['language'] ?? 'unknown');
    const existing = counts.get(filePath);
    if (existing) existing.chunk_count++;
    else counts.set(filePath, { language, chunk_count: 1 });
  }

  return [...counts.entries()]
    .map(([file_path, v]) => ({ file_path, ...v }))
    .sort((a, b) => a.file_path.localeCompare(b.file_path));
}

// --- snapshot registry ----------------------------------------------------

export type { SnapshotRecord };

/** Snapshots in the on-disk registry, newest first. */
export function listSnapshots(): SnapshotRecord[] {
  const reg = loadRegistry();
  // String compare on ISO timestamps is the lexicographic == chronological order.
  return reg.snapshots.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --- config read/write ----------------------------------------------------

/** Read the current config from disk and return it raw (with defaults filled in). */
export function readConfig(): { path: string; exists: boolean; config: RagolithConfig } {
  const path = configFilePath();
  const exists = existsSync(path);
  // loadConfig() merges file + env + defaults — exactly what the rest of the
  // app uses, so the dashboard sees the same view.
  resetConfigCache();
  const config = loadConfig();
  return { path, exists, config };
}

const CONFIG_SHAPE_HINT =
  'expected an object with weaviate, ingest, search, repos[], documents[], backup keys';

/** Validate + atomically write a new config to disk. Throws on shape errors. */
export async function writeConfig(next: unknown): Promise<{ path: string }> {
  // Minimal structural validation. We deliberately don't deep-validate every
  // field — loadConfig() merges with defaults so missing optional fields are
  // fine. We just guard against catastrophic shape errors (not-an-object,
  // arrays where we expect objects, etc).
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error(`config must be a JSON object — ${CONFIG_SHAPE_HINT}`);
  }
  const c = next as Record<string, unknown>;
  // `projects`/`files` still accepted as legacy aliases — loadConfig() will
  // migrate them on the next read.
  for (const key of ['repos', 'projects'] as const) {
    if (c[key] !== undefined && !Array.isArray(c[key])) {
      throw new Error(`config.${key} must be an array`);
    }
  }
  for (const key of ['documents', 'files'] as const) {
    if (c[key] !== undefined && !Array.isArray(c[key])) {
      throw new Error(`config.${key} must be an array`);
    }
  }
  for (const k of ['weaviate', 'ingest', 'search', 'backup']) {
    const v = c[k];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      throw new Error(`config.${k} must be an object`);
    }
  }

  const path = configFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  // Atomic write: tmp file + rename. Avoids leaving a half-written config
  // if the process is killed mid-write.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
  // Invalidate the cache so subsequent loadConfig() picks up the new file.
  resetConfigCache();
  return { path };
}

// --- CLI job runner -------------------------------------------------------
//
// Generic runner for spawning ragolith CLIs (ingest, backup, …) as child
// processes and streaming their output to dashboard subscribers via SSE. We
// keep these out of the dashboard's import graph to preserve the layer
// boundary — calling them as subprocesses gives the same UX and keeps the
// build clean.
//
// Only one job runs at a time: ingest and backup both touch Weaviate, and
// the dashboard is a single-user localhost tool, so serialization is the
// safe default. The 409 conflict response is the user's signal.
//
// Late subscribers (e.g. user refreshes the page mid-run) get the buffered
// log lines replayed so they don't miss context.

export type JobKind = 'ingest' | 'backup';
export type JobStatus = 'running' | 'success' | 'failed';

export interface JobState {
  id: string;
  kind: JobKind;
  args: string[];
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: JobStatus;
}

export interface IngestOptions {
  full?: boolean;
  project?: string;
  file?: string;
  migrateOnly?: boolean;
}

export type BackupCommand = 'create' | 'restore' | 'verify' | 'push' | 'pull';

export interface BackupOptions {
  command: BackupCommand;
  /** Required for create/restore/push/pull; not used by verify. */
  id?: string;
  /** create only — push the snapshot to S3 after it lands locally. */
  pushS3?: boolean;
  /** restore only — pull from S3 into the local volume before restoring. */
  pullS3?: boolean;
  /** verify only — leave the verify snapshot on the volume on success. */
  keep?: boolean;
}

interface JobStreamPayload {
  type: 'start' | 'log' | 'exit';
  kind?: JobKind;
  line?: string;
  code?: number;
  job?: JobState;
}

interface ActiveJob {
  state: JobState;
  process: ChildProcess;
  buffer: string[];
}

let activeJob: ActiveJob | null = null;
const jobSubscribers = new Set<(p: JobStreamPayload) => void>();

function cliPath(name: 'ingest' | 'backup'): string {
  // dist/dashboard/api.js → ../cli/<name>.js. Also works under tsx in dev
  // because tsx mirrors the same relative layout from src/.
  return resolve(dirname(fileURLToPath(import.meta.url)), `../cli/${name}.js`);
}

function makeLineBuffer(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    },
    flush() {
      if (buf.length > 0) {
        onLine(buf);
        buf = '';
      }
    },
  };
}

function dispatch(payload: JobStreamPayload): void {
  for (const sub of jobSubscribers) {
    try {
      sub(payload);
    } catch {
      // a misbehaving subscriber must not stop the others
    }
  }
}

export function getActiveJob(): JobState | null {
  return activeJob ? activeJob.state : null;
}

/**
 * Backup id validation. Weaviate enforces `[a-z0-9_-]+` server-side; we mirror
 * that here so the user gets an instant 400 instead of waiting for the child
 * to spawn just to get rejected by Weaviate.
 */
const ID_RE = /^[a-z0-9_-]+$/;

function startJob(kind: JobKind, args: string[]): JobState {
  if (activeJob && activeJob.state.status === 'running') {
    throw new Error(`a ${activeJob.state.kind} job is already running`);
  }

  const state: JobState = {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    args,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    status: 'running',
  };

  const proc = spawn('node', args, {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const job: ActiveJob = { state, process: proc, buffer: [] };
  activeJob = job;

  const onLine = (line: string): void => {
    job.buffer.push(line);
    dispatch({ type: 'log', kind, line });
  };
  const lineBuf = makeLineBuffer(onLine);

  proc.stdout?.on('data', (chunk: Buffer) => lineBuf.push(chunk.toString('utf-8')));
  proc.stderr?.on('data', (chunk: Buffer) => lineBuf.push(chunk.toString('utf-8')));

  proc.on('exit', (code) => {
    lineBuf.flush();
    state.endedAt = Date.now();
    state.exitCode = code;
    state.status = code === 0 ? 'success' : 'failed';
    dispatch({ type: 'exit', kind, code: code ?? 1 });
  });

  proc.on('error', (err) => {
    onLine(`[${kind}] spawn error: ${err.message}`);
    state.endedAt = Date.now();
    state.exitCode = -1;
    state.status = 'failed';
    dispatch({ type: 'exit', kind, code: -1 });
  });

  dispatch({ type: 'start', kind, job: state });
  return state;
}

export function startIngest(opts: IngestOptions = {}): JobState {
  const args: string[] = [cliPath('ingest')];
  if (opts.full) args.push('--full');
  if (opts.project) args.push('--project', opts.project);
  if (opts.file) args.push('--file', opts.file);
  if (opts.migrateOnly) args.push('--migrate-only');
  return startJob('ingest', args);
}

export function startBackup(opts: BackupOptions): JobState {
  if (!opts.command) throw new Error('backup command is required');
  const args: string[] = [cliPath('backup'), opts.command];
  if (opts.command === 'verify') {
    if (opts.keep) args.push('--keep');
  } else {
    // create / restore / push / pull all take an id positional.
    if (!opts.id || !ID_RE.test(opts.id)) {
      throw new Error(
        `backup id must be non-empty and match ${ID_RE.source} (lowercase letters, digits, _ or -)`,
      );
    }
    args.push(opts.id);
    if (opts.command === 'create' && opts.pushS3) args.push('--push-s3');
    if (opts.command === 'restore' && opts.pullS3) args.push('--pull-s3');
  }
  return startJob('backup', args);
}

/**
 * Register a subscriber for job events. Buffered lines from the current
 * (or most recent) job are replayed immediately so late subscribers see the
 * full picture. Returns an unsubscribe function.
 */
export function subscribeJobs(fn: (p: JobStreamPayload) => void): () => void {
  jobSubscribers.add(fn);
  if (activeJob) {
    const kind = activeJob.state.kind;
    fn({ type: 'start', kind, job: activeJob.state });
    for (const line of activeJob.buffer) fn({ type: 'log', kind, line });
    if (activeJob.state.status !== 'running') {
      fn({ type: 'exit', kind, code: activeJob.state.exitCode ?? 1 });
    }
  }
  return () => jobSubscribers.delete(fn);
}
