// Weaviate connection + collection schema management.
//
// Three collections:
//   - CodeChunk    — vectorized code/doc chunks; the primary search target.
//   - SymbolRecord — function/class/method index for structural lookups.
//   - CallEdge     — caller→callee edges (TS/JS only) for call-graph queries.

import weaviate, {
  type WeaviateClient,
  dataType,
  vectorizer,
  reranker,
  configure,
  Filters,
} from 'weaviate-client';
import type { WeaviateConnConfig } from './types.js';

export const CODE_CHUNK = 'CodeChunk';
export const SYMBOL_RECORD = 'SymbolRecord';
export const CALL_EDGE = 'CallEdge';

export async function connect(cfg: WeaviateConnConfig): Promise<WeaviateClient> {
  return weaviate.connectToCustom({
    httpHost: cfg.host,
    httpPort: cfg.httpPort,
    httpSecure: cfg.secure,
    grpcHost: cfg.host,
    grpcPort: cfg.grpcPort,
    grpcSecure: cfg.secure,
    authCredentials: cfg.apiKey ? new weaviate.ApiKey(cfg.apiKey) : undefined,
  });
}

/**
 * Idempotently create the three collections. Safe to call on every server/ingest start.
 * If a collection already exists, it is left untouched (no destructive migration).
 */
export async function ensureSchema(client: WeaviateClient): Promise<void> {
  const existing = new Set((await client.collections.listAll()).map((c) => c.name));

  if (!existing.has(CODE_CHUNK)) {
    await client.collections.create({
      name: CODE_CHUNK,
      // Embed only `content` — other fields are filterable metadata.
      vectorizers: vectorizer.text2VecTransformers({
        name: 'default',
        sourceProperties: ['content'],
      }),
      reranker: reranker.transformers(),
      invertedIndex: configure.invertedIndex({
        indexNullState: true,
        indexPropertyLength: true,
      }),
      properties: [
        { name: 'content', dataType: dataType.TEXT },
        { name: 'raw_content', dataType: dataType.TEXT, skipVectorization: true },
        { name: 'file_path', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'project', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'start_line', dataType: dataType.INT },
        { name: 'end_line', dataType: dataType.INT },
        { name: 'language', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'chunk_type', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'symbol', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'commit_sha', dataType: dataType.TEXT, tokenization: 'field' },
      ],
    });
  }

  if (!existing.has(SYMBOL_RECORD)) {
    await client.collections.create({
      name: SYMBOL_RECORD,
      // No vectorizer — this collection is for exact/structural lookups.
      vectorizers: vectorizer.none(),
      properties: [
        { name: 'name', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'kind', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'signature', dataType: dataType.TEXT },
        { name: 'parent', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'exports', dataType: dataType.BOOLEAN },
        { name: 'file_path', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'project', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'start_line', dataType: dataType.INT },
        { name: 'end_line', dataType: dataType.INT },
        { name: 'language', dataType: dataType.TEXT, tokenization: 'field' },
      ],
    });
  }

  if (!existing.has(CALL_EDGE)) {
    await client.collections.create({
      name: CALL_EDGE,
      vectorizers: vectorizer.none(),
      properties: [
        { name: 'caller', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'callee', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'call_type', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'file', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'line', dataType: dataType.INT },
        { name: 'project', dataType: dataType.TEXT, tokenization: 'field' },
      ],
    });
  }
}

/** Delete all objects belonging to a project — used before re-ingesting on a full rebuild. */
export async function deleteProject(client: WeaviateClient, project: string): Promise<void> {
  for (const name of [CODE_CHUNK, SYMBOL_RECORD, CALL_EDGE]) {
    const col = client.collections.get(name);
    await col.data.deleteMany(col.filter.byProperty('project').equal(project));
  }
}

/** Delete chunks/symbols/edges for specific files in a project — used for incremental updates. */
export async function deleteFiles(
  client: WeaviateClient,
  project: string,
  files: string[],
): Promise<void> {
  if (files.length === 0) return;
  const chunks = client.collections.get(CODE_CHUNK);
  await chunks.data.deleteMany(
    Filters.and(
      chunks.filter.byProperty('project').equal(project),
      chunks.filter.byProperty('file_path').containsAny(files),
    ),
  );
  const symbols = client.collections.get(SYMBOL_RECORD);
  await symbols.data.deleteMany(
    Filters.and(
      symbols.filter.byProperty('project').equal(project),
      symbols.filter.byProperty('file_path').containsAny(files),
    ),
  );
  const edges = client.collections.get(CALL_EDGE);
  await edges.data.deleteMany(
    Filters.and(
      edges.filter.byProperty('project').equal(project),
      edges.filter.byProperty('file').containsAny(files),
    ),
  );
}
