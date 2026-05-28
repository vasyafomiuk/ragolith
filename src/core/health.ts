// Stack health probe — Weaviate HTTP + gRPC + transformer modules + ingest state file.
//
// Lives in core/ so both the dashboard's /api/health endpoint and the
// ragolith-doctor CLI can consume it. Pure async function with no
// side-effects on the filesystem; the result is a snapshot describing
// reachability and configuration at the moment it was called.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { connect } from './weaviate-client.js';
import type { IngestState } from './types.js';

export interface HealthStatus {
  weaviate: {
    http: boolean;
    grpc: boolean;
    error?: string;
  };
  embedder: {
    reachable: boolean;
    error?: string;
  };
  reranker: {
    reachable: boolean;
    enabled: boolean;
  };
  state: {
    path: string;
    exists: boolean;
    projects: string[];
    files: string[];
  };
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
  const cfg = loadConfig();
  const stateFile = resolve(cfg.ingest.stateFile);
  const state = loadState();

  const result: HealthStatus = {
    weaviate: { http: false, grpc: false },
    embedder: { reachable: false },
    reranker: { reachable: false, enabled: cfg.search.rerankerEnabled },
    state: {
      path: stateFile,
      exists: existsSync(stateFile),
      projects: Object.keys(state.projects),
      files: Object.keys(state.files),
    },
  };

  const base = `http${cfg.weaviate.secure ? 's' : ''}://${cfg.weaviate.host}:${cfg.weaviate.httpPort}`;

  // HTTP probe via Weaviate's readiness endpoint — does not need the client.
  try {
    const r = await fetch(`${base}/v1/.well-known/ready`, { signal: AbortSignal.timeout(2000) });
    result.weaviate.http = r.ok;
  } catch (err) {
    result.weaviate.error = err instanceof Error ? err.message : String(err);
  }

  // gRPC probe via the typed client. Don't cache — doctor runs once and exits.
  try {
    const client = await connect(cfg.weaviate);
    try {
      result.weaviate.grpc = await client.isLive();
    } finally {
      await client.close();
    }
  } catch (err) {
    if (!result.weaviate.error) {
      result.weaviate.error = err instanceof Error ? err.message : String(err);
    }
  }

  // The transformer modules surface on /v1/meta when loaded.
  try {
    const meta = await fetch(`${base}/v1/meta`, { signal: AbortSignal.timeout(2000) });
    if (meta.ok) {
      const body = (await meta.json()) as { modules?: Record<string, unknown> };
      result.embedder.reachable = !!body.modules?.['text2vec-transformers'];
      result.reranker.reachable = !!body.modules?.['reranker-transformers'];
    }
  } catch (err) {
    result.embedder.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}
