// Weaviate connection + collection schema management.
//
// Five collections:
//   - CodeChunk    — vectorized code/doc chunks; the primary search target.
//   - SymbolRecord — function/class/method index for structural lookups.
//   - CallEdge     — caller→callee edges (TS/JS only) for call-graph queries.
//   - ProjectStack — per-project detected tech stack (frameworks, runtimes).
//   - SdlcArtifact — vectorized SDLC artifacts (requirements, decisions, …).

import weaviate, {
  generateUuid5,
  type WeaviateClient,
  dataType,
  vectorizer,
  reranker,
  configure,
  Filters,
} from 'weaviate-client';
import type { TechStack, WeaviateConnConfig } from './types.js';

export const CODE_CHUNK = 'CodeChunk';
export const SYMBOL_RECORD = 'SymbolRecord';
export const CALL_EDGE = 'CallEdge';
export const PROJECT_STACK = 'ProjectStack';
export const SDLC_ARTIFACT = 'SdlcArtifact';

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

export interface SchemaOptions {
  /**
   * Whether to attach `reranker-transformers` to the CodeChunk collection.
   * Skip this when running against a Weaviate that doesn't have the reranker
   * module loaded — schema creation would 422 otherwise. The query-time
   * `rerankerEnabled` flag in search config is independent: if you ever flip
   * it on against a Weaviate without the module, the search code already has
   * a graceful fallback. Defaults to true.
   */
  reranker?: boolean;
}

/**
 * Idempotently create the three collections. Safe to call on every server/ingest start.
 * If a collection already exists, it is left untouched (no destructive migration).
 *
 * For property additions, tokenization changes, etc. against existing schemas,
 * use `runMigrations` from ./migrations.ts.
 */
export async function ensureSchema(
  client: WeaviateClient,
  opts: SchemaOptions = {},
): Promise<void> {
  const withReranker = opts.reranker ?? true;
  const existing = new Set((await client.collections.listAll()).map((c) => c.name));

  if (!existing.has(CODE_CHUNK)) {
    await client.collections.create({
      name: CODE_CHUNK,
      // Embed only `content` — other fields are filterable metadata.
      vectorizers: vectorizer.text2VecTransformers({
        name: 'default',
        sourceProperties: ['content'],
      }),
      ...(withReranker ? { reranker: reranker.transformers() } : {}),
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

  if (!existing.has(PROJECT_STACK)) {
    await client.collections.create({
      name: PROJECT_STACK,
      // One row per project; no vectors. Flat scalar/array fields are
      // filterable so future search tools can ask "all projects with React".
      // The rich structure (frameworks[], manifests[], runtimes map) lives
      // inside *_json TEXT blobs so the schema doesn't have to keep up with
      // nested-object shape changes.
      vectorizers: vectorizer.none(),
      properties: [
        { name: 'project', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'languages', dataType: dataType.TEXT_ARRAY, skipVectorization: true },
        { name: 'build_tools', dataType: dataType.TEXT_ARRAY, skipVectorization: true },
        { name: 'framework_names', dataType: dataType.TEXT_ARRAY, skipVectorization: true },
        { name: 'runtimes_json', dataType: dataType.TEXT, skipVectorization: true },
        { name: 'frameworks_json', dataType: dataType.TEXT, skipVectorization: true },
        { name: 'manifests_json', dataType: dataType.TEXT, skipVectorization: true },
        { name: 'detected_at', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'commit_sha', dataType: dataType.TEXT, tokenization: 'field' },
      ],
    });
  }

  if (!existing.has(SDLC_ARTIFACT)) {
    await client.collections.create({
      name: SDLC_ARTIFACT,
      // Embed `title` + `body` (joined into `content`); the rest is filterable
      // metadata. Links live in a JSON blob so the relationship vocabulary can
      // grow without schema migrations — gap analysis parses links_json.
      vectorizers: vectorizer.text2VecTransformers({
        name: 'default',
        sourceProperties: ['content'],
      }),
      ...(withReranker ? { reranker: reranker.transformers() } : {}),
      invertedIndex: configure.invertedIndex({
        indexNullState: true,
        indexPropertyLength: true,
      }),
      properties: [
        { name: 'content', dataType: dataType.TEXT },
        { name: 'raw_body', dataType: dataType.TEXT, skipVectorization: true },
        { name: 'artifact_id', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'title', dataType: dataType.TEXT },
        { name: 'kind', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'status', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'source', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'project', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'tags', dataType: dataType.TEXT_ARRAY, skipVectorization: true },
        { name: 'author', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'url', dataType: dataType.TEXT, skipVectorization: true },
        { name: 'links_json', dataType: dataType.TEXT, skipVectorization: true },
        // Denormalized link facets for cheap filtering without parsing JSON.
        { name: 'link_rels', dataType: dataType.TEXT_ARRAY, skipVectorization: true },
        { name: 'link_targets', dataType: dataType.TEXT_ARRAY, skipVectorization: true },
        { name: 'created_at', dataType: dataType.TEXT, tokenization: 'field' },
        { name: 'updated_at', dataType: dataType.TEXT, tokenization: 'field' },
      ],
    });
  }
}

/** Stable UUID for an artifact — source + id is unique. */
export function artifactUuid(source: string, artifactId: string): string {
  return generateUuid5(`sdlc::${source}::${artifactId}`);
}

/** Delete every artifact belonging to one SDLC source label. */
export async function deleteSdlcSource(client: WeaviateClient, source: string): Promise<void> {
  const col = client.collections.get(SDLC_ARTIFACT);
  await col.data.deleteMany(col.filter.byProperty('source').equal(source));
}

/**
 * Upsert the TechStack for one project. Delete-then-insert pattern mirrors
 * how the rest of the code re-ingests: deterministic UUID derived from the
 * project name means the new row replaces the old one cleanly.
 */
export async function upsertTechStack(client: WeaviateClient, stack: TechStack): Promise<void> {
  const col = client.collections.get(PROJECT_STACK);
  await col.data.deleteMany(col.filter.byProperty('project').equal(stack.project));
  await col.data.insertMany([
    {
      id: generateUuid5(`stack::${stack.project}`),
      properties: {
        project: stack.project,
        languages: stack.languages,
        build_tools: stack.build_tools,
        framework_names: stack.frameworks.map((f) => f.name),
        runtimes_json: JSON.stringify(stack.runtimes),
        frameworks_json: JSON.stringify(stack.frameworks),
        manifests_json: JSON.stringify(stack.manifests),
        detected_at: stack.detected_at,
        commit_sha: stack.commit_sha ?? '',
      },
    },
  ]);
}

/**
 * Read the TechStack for one project. Returns `undefined` when nothing has
 * been ingested for that project name yet — distinguishable from "an empty
 * stack was detected" (which returns a record with empty arrays).
 */
export async function getTechStack(
  client: WeaviateClient,
  project: string,
): Promise<TechStack | undefined> {
  const col = client.collections.get(PROJECT_STACK);
  const res = await col.query.fetchObjects({
    filters: col.filter.byProperty('project').equal(project),
    limit: 1,
  });
  const obj = res.objects[0];
  if (!obj) return undefined;
  const p = obj.properties as Record<string, unknown>;
  const stack: TechStack = {
    project: String(p['project'] ?? project),
    languages: (p['languages'] as string[] | undefined) ?? [],
    build_tools: (p['build_tools'] as TechStack['build_tools'] | undefined) ?? [],
    runtimes: safeParseJson<Record<string, string>>(p['runtimes_json']) ?? {},
    frameworks: safeParseJson<TechStack['frameworks']>(p['frameworks_json']) ?? [],
    manifests: safeParseJson<TechStack['manifests']>(p['manifests_json']) ?? [],
    detected_at: String(p['detected_at'] ?? ''),
  };
  const sha = String(p['commit_sha'] ?? '');
  if (sha) stack.commit_sha = sha;
  return stack;
}

function safeParseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Delete all objects belonging to a project — used before re-ingesting on a full rebuild. */
export async function deleteProject(client: WeaviateClient, project: string): Promise<void> {
  for (const name of [CODE_CHUNK, SYMBOL_RECORD, CALL_EDGE, PROJECT_STACK]) {
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
