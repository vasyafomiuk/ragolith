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
import { resolve } from 'node:path';
import type { WeaviateClient } from 'weaviate-client';
import { loadConfig } from '../core/config.js';
import { connect, CODE_CHUNK } from '../core/weaviate-client.js';
import { search } from '../core/search.js';
import { health as coreHealth, type HealthStatus } from '../core/health.js';
import type { IngestState, Language, SearchHit } from '../core/types.js';

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
