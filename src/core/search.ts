// Search pipeline:
//   1. Classify query shape → select alpha (keyword vs semantic blend).
//   2. Expand query (camelCase split, light synonym map).
//   3. Hybrid search (BM25 + vector) with 2× over-fetch.
//   4. Cross-encoder rerank (graceful fallback if unavailable).
//   5. Autocut at the largest score gap.
//   6. Diversity filter (max N results per file).

import { Filters, type WeaviateClient } from 'weaviate-client';
import { CODE_CHUNK, SDLC_ARTIFACT } from './weaviate-client.js';
import type { ArtifactHit, Language, SdlcArtifactKind, SearchHit, SearchProfile } from './types.js';

// --- effort presets ---------------------------------------------------------

export interface SearchProfileSettings {
  overFetch: number;
  diversityPerFile: number;
  rerankerEnabled: boolean;
  limit: number;
  maxContentChars: number;
}

/**
 * The three named effort presets. Higher effort = better recall/quality and a
 * larger token footprint; lower effort = fewer, shorter results for minimum
 * token consumption downstream. The dashboard's preset buttons write these
 * values into `ragc.config.json`'s `search` block, which both the MCP server
 * and the dashboard read.
 */
export const SEARCH_PROFILES: Record<Exclude<SearchProfile, 'custom'>, SearchProfileSettings> = {
  productivity: {
    overFetch: 3,
    diversityPerFile: 4,
    rerankerEnabled: true,
    limit: 20,
    maxContentChars: 4000,
  },
  balanced: {
    overFetch: 2,
    diversityPerFile: 3,
    rerankerEnabled: true,
    limit: 10,
    maxContentChars: 1200,
  },
  frugal: {
    overFetch: 1,
    diversityPerFile: 2,
    rerankerEnabled: false,
    limit: 5,
    maxContentChars: 400,
  },
};

/** Truncate text to `max` chars (adding an ellipsis), or return it unchanged. */
export function truncateContent(text: string, max: number | undefined): string {
  if (!max || max <= 0 || text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export interface SearchOptions {
  query: string;
  limit?: number;
  project?: string;
  language?: Language;
  /** Pipeline knobs — read from config by the caller. */
  overFetch: number;
  diversityPerFile: number;
  rerankerEnabled: boolean;
  /** Truncate each hit's content to this many chars (token lever). */
  maxContentChars?: number;
}

// --- 1. classify ---

/** Returns an alpha in [0, 1] where 0 = pure BM25 and 1 = pure vector. */
export function classifyAlpha(query: string): number {
  const trimmed = query.trim();
  // Looks like an identifier or symbol query (camelCase, snake_case, has a dot)
  // → lean keyword.
  const identifierish = /^[A-Za-z_][\w]*([.:][A-Za-z_][\w]*)*$/.test(trimmed);
  if (identifierish) return 0.25;
  // Very short queries are usually keyword lookups.
  if (trimmed.split(/\s+/).length <= 2) return 0.4;
  // Natural-language questions lean semantic.
  if (/[?]\s*$/.test(trimmed) || /^(how|why|what|where|when|explain)/i.test(trimmed)) return 0.8;
  return 0.6;
}

// --- 2. expand ---

const SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'authorization', 'login'],
  db: ['database'],
  ui: ['frontend', 'interface'],
  api: ['endpoint', 'route'],
  err: ['error', 'exception'],
  cfg: ['config', 'configuration'],
};

function splitCamelSnake(word: string): string[] {
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean);
  return parts.length > 1 ? parts : [];
}

export function expandQuery(query: string): string {
  const tokens = query.split(/\s+/);
  const extra = new Set<string>();
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    const syns = SYNONYMS[lower];
    if (syns) syns.forEach((s) => extra.add(s));
    for (const split of splitCamelSnake(tok)) extra.add(split);
  }
  if (extra.size === 0) return query;
  return `${query} ${[...extra].join(' ')}`;
}

// --- 5. autocut ---

/** Return all hits up to and including the largest score gap. */
export function autocut(scores: number[]): number {
  if (scores.length <= 1) return scores.length;
  let gapIdx = scores.length;
  let gap = 0;
  for (let i = 1; i < scores.length; i++) {
    const a = scores[i - 1] ?? 0;
    const b = scores[i] ?? 0;
    const d = a - b;
    if (d > gap) {
      gap = d;
      gapIdx = i;
    }
  }
  // If the best gap is trivial, keep everything.
  if (gap < 0.05) return scores.length;
  return gapIdx;
}

// --- 6. diversity ---

export function diversityFilter<T extends { file_path: string }>(hits: T[], perFile: number): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const h of hits) {
    const n = counts.get(h.file_path) ?? 0;
    if (n >= perFile) continue;
    counts.set(h.file_path, n + 1);
    out.push(h);
  }
  return out;
}

// --- main entry ---

export async function search(client: WeaviateClient, opts: SearchOptions): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const alpha = classifyAlpha(opts.query);
  const expanded = expandQuery(opts.query);
  const overFetchLimit = limit * Math.max(1, opts.overFetch);

  const collection = client.collections.get(CODE_CHUNK);

  // Build filters declaratively from opts.
  const clauses = [
    opts.project ? collection.filter.byProperty('project').equal(opts.project) : undefined,
    opts.language ? collection.filter.byProperty('language').equal(opts.language) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const filter =
    clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : Filters.and(...clauses);

  // Stage 3 — hybrid retrieval with optional reranker.
  let response;
  try {
    response = await collection.query.hybrid(expanded, {
      alpha,
      limit: overFetchLimit,
      returnMetadata: ['score'],
      ...(filter ? { filters: filter } : {}),
      ...(opts.rerankerEnabled ? { rerank: { property: 'content', query: opts.query } } : {}),
    });
  } catch (err) {
    // Stage 4 — graceful fallback if the reranker module is unavailable.
    if (opts.rerankerEnabled) {
      response = await collection.query.hybrid(expanded, {
        alpha,
        limit: overFetchLimit,
        returnMetadata: ['score'],
        ...(filter ? { filters: filter } : {}),
      });
    } else {
      throw err;
    }
  }

  const ranked: SearchHit[] = response.objects.map((o) => {
    const p = o.properties as Record<string, unknown>;
    const meta = o.metadata as { score?: number; rerankScore?: number } | undefined;
    const score = meta?.rerankScore ?? meta?.score ?? 0;
    const hit: SearchHit = {
      content: (p['raw_content'] as string) ?? (p['content'] as string) ?? '',
      file_path: (p['file_path'] as string) ?? '',
      project: (p['project'] as string) ?? '',
      start_line: Number(p['start_line'] ?? 0),
      end_line: Number(p['end_line'] ?? 0),
      language: (p['language'] as Language) ?? 'unknown',
      chunk_type: (p['chunk_type'] as SearchHit['chunk_type']) ?? 'fallback',
      score,
    };
    const symbol = p['symbol'];
    if (typeof symbol === 'string' && symbol.length > 0) hit.symbol = symbol;
    return hit;
  });

  // Stage 5 — autocut on the (possibly reranked) score series.
  const cutoff = autocut(ranked.map((h) => h.score));
  const trimmed = ranked.slice(0, cutoff);

  // Stage 6 — diversity filter then final limit.
  const diverse = diversityFilter(trimmed, opts.diversityPerFile);
  const limited = diverse.slice(0, limit);

  // Stage 7 — optional content truncation to cap token footprint.
  if (opts.maxContentChars && opts.maxContentChars > 0) {
    for (const h of limited) h.content = truncateContent(h.content, opts.maxContentChars);
  }
  return limited;
}

// --- SDLC artifact search ---------------------------------------------------

export interface ArtifactSearchOptions {
  query: string;
  limit?: number;
  project?: string;
  source?: string;
  kind?: SdlcArtifactKind;
  rerankerEnabled: boolean;
  /** Max chars of artifact body returned per hit. Defaults to 500. */
  maxContentChars?: number;
}

/**
 * Hybrid search over the SDLC artifact index. Same classify→expand→hybrid→
 * rerank→autocut shape as code search, minus the per-file diversity step
 * (artifacts are whole documents, not chunks of one file).
 */
export async function searchArtifacts(
  client: WeaviateClient,
  opts: ArtifactSearchOptions,
): Promise<ArtifactHit[]> {
  const limit = opts.limit ?? 10;
  const alpha = classifyAlpha(opts.query);
  const expanded = expandQuery(opts.query);

  const col = client.collections.get(SDLC_ARTIFACT);
  const clauses = [
    opts.project ? col.filter.byProperty('project').equal(opts.project) : undefined,
    opts.source ? col.filter.byProperty('source').equal(opts.source) : undefined,
    opts.kind ? col.filter.byProperty('kind').equal(opts.kind) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const filter =
    clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : Filters.and(...clauses);

  const overFetch = limit * 2;
  let response;
  try {
    response = await col.query.hybrid(expanded, {
      alpha,
      limit: overFetch,
      returnMetadata: ['score'],
      ...(filter ? { filters: filter } : {}),
      ...(opts.rerankerEnabled ? { rerank: { property: 'content', query: opts.query } } : {}),
    });
  } catch (err) {
    if (opts.rerankerEnabled) {
      response = await col.query.hybrid(expanded, {
        alpha,
        limit: overFetch,
        returnMetadata: ['score'],
        ...(filter ? { filters: filter } : {}),
      });
    } else {
      throw err;
    }
  }

  const ranked: ArtifactHit[] = response.objects.map((o) => {
    const p = o.properties as Record<string, unknown>;
    const meta = o.metadata as { score?: number; rerankScore?: number } | undefined;
    const body = (p['raw_body'] as string) ?? '';
    const excerptMax =
      opts.maxContentChars && opts.maxContentChars > 0 ? opts.maxContentChars : 500;
    const hit: ArtifactHit = {
      artifact_id: (p['artifact_id'] as string) ?? '',
      kind: ((p['kind'] as string) || 'other') as SdlcArtifactKind,
      title: (p['title'] as string) ?? '',
      excerpt: truncateContent(body, excerptMax),
      source: (p['source'] as string) ?? '',
      project: (p['project'] as string) ?? '',
      score: meta?.rerankScore ?? meta?.score ?? 0,
    };
    const status = p['status'];
    if (typeof status === 'string' && status) hit.status = status;
    const url = p['url'];
    if (typeof url === 'string' && url) hit.url = url;
    return hit;
  });

  const cutoff = autocut(ranked.map((h) => h.score));
  return ranked.slice(0, cutoff).slice(0, limit);
}
