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
import type { WeaviateClient } from 'weaviate-client';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { connect, CODE_CHUNK } from '../core/weaviate-client.js';
import { search } from '../core/search.js';
import { health as coreHealth, type HealthStatus } from '../core/health.js';
import type { IngestState, Language, RagolithConfig, SearchHit } from '../core/types.js';

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

// --- config read/write ----------------------------------------------------

function configPath(): string {
  return resolve(process.env['RAGOLITH_CONFIG'] ?? resolve(process.cwd(), 'ragc.config.json'));
}

/** Read the current config from disk and return it raw (with defaults filled in). */
export function readConfig(): { path: string; exists: boolean; config: RagolithConfig } {
  const path = configPath();
  const exists = existsSync(path);
  // loadConfig() merges file + env + defaults — exactly what the rest of the
  // app uses, so the dashboard sees the same view.
  resetConfigCache();
  const config = loadConfig();
  return { path, exists, config };
}

const CONFIG_SHAPE_HINT =
  'expected an object with weaviate, ingest, search, projects[], files[], backup keys';

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
  if (c['projects'] !== undefined && !Array.isArray(c['projects'])) {
    throw new Error('config.projects must be an array');
  }
  if (c['files'] !== undefined && !Array.isArray(c['files'])) {
    throw new Error('config.files must be an array');
  }
  for (const k of ['weaviate', 'ingest', 'search', 'backup']) {
    const v = c[k];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      throw new Error(`config.${k} must be an object`);
    }
  }

  const path = configPath();
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
