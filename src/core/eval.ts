// Search-quality eval harness.
//
// Loads a JSON file of golden queries, each with an expected set of "matches"
// (file paths that *should* show up in the top-K results). Runs each query
// through the live search() pipeline and scores precision@K and MRR. Returns
// a structured report consumable by the ragolith-eval CLI.
//
// The fixture corpus is the caller's responsibility — typically you'd ingest
// a known repo against a dedicated project name, then run eval against it.
// This module makes no assumptions about what's already indexed.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WeaviateClient } from 'weaviate-client';
import { search } from './search.js';
import { loadConfig } from './config.js';
import type { Language } from './types.js';

/** One scored question in a golden-set file. */
export interface GoldenQuery {
  id: string;
  query: string;
  /** Substring matched against SearchHit.file_path — case-sensitive. */
  expect: string[];
  /** Optional project filter to scope the search to a fixture corpus. */
  project?: string;
  language?: Language;
}

export interface EvalConfig {
  queries: GoldenQuery[];
  /** Hits to fetch per query before computing the score. Default 10. */
  k?: number;
}

export interface QueryScore {
  id: string;
  query: string;
  k: number;
  /** Number of expected matches found anywhere in the top-K result list. */
  hits: number;
  /** hits / expect.length — fraction of expected matches that surfaced. */
  recall: number;
  /** Reciprocal rank of the FIRST expected match (1 / rank). 0 if none found. */
  reciprocalRank: number;
  /** The actual top-K file paths returned, for debugging. */
  topFiles: string[];
}

export interface EvalReport {
  k: number;
  total: number;
  averageRecall: number;
  meanReciprocalRank: number;
  perQuery: QueryScore[];
}

export async function loadGoldenSet(path: string): Promise<EvalConfig> {
  const raw = await readFile(resolve(path), 'utf-8');
  const parsed = JSON.parse(raw) as EvalConfig;
  if (!Array.isArray(parsed.queries)) {
    throw new Error(`golden-set file ${path} is missing a "queries" array`);
  }
  for (const q of parsed.queries) {
    if (!q.id || !q.query || !Array.isArray(q.expect)) {
      throw new Error(`golden-set entry malformed: ${JSON.stringify(q)}`);
    }
  }
  return parsed;
}

export function scoreQuery(query: GoldenQuery, topFiles: string[], k: number): QueryScore {
  const expected = new Set(query.expect);
  let hits = 0;
  let firstHitRank = 0;
  for (let i = 0; i < topFiles.length; i++) {
    const file = topFiles[i]!;
    let matched = false;
    for (const e of expected) {
      if (file.includes(e)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      hits++;
      if (firstHitRank === 0) firstHitRank = i + 1;
    }
  }
  return {
    id: query.id,
    query: query.query,
    k,
    hits,
    recall: expected.size > 0 ? hits / expected.size : 0,
    reciprocalRank: firstHitRank > 0 ? 1 / firstHitRank : 0,
    topFiles,
  };
}

export async function runEval(client: WeaviateClient, cfg: EvalConfig): Promise<EvalReport> {
  const k = cfg.k ?? 10;
  const ragCfg = loadConfig();
  const perQuery: QueryScore[] = [];

  for (const q of cfg.queries) {
    const hits = await search(client, {
      query: q.query,
      limit: k,
      ...(q.project ? { project: q.project } : {}),
      ...(q.language ? { language: q.language } : {}),
      overFetch: ragCfg.search.overFetch,
      diversityPerFile: ragCfg.search.diversityPerFile,
      rerankerEnabled: ragCfg.search.rerankerEnabled,
    });
    perQuery.push(
      scoreQuery(
        q,
        hits.map((h) => h.file_path),
        k,
      ),
    );
  }

  const total = perQuery.length;
  const averageRecall = total > 0 ? perQuery.reduce((a, q) => a + q.recall, 0) / total : 0;
  const meanReciprocalRank =
    total > 0 ? perQuery.reduce((a, q) => a + q.reciprocalRank, 0) / total : 0;

  return {
    k,
    total,
    averageRecall,
    meanReciprocalRank,
    perQuery,
  };
}
