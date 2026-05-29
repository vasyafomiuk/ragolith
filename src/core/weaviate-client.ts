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
import type { ArtifactLink, SdlcArtifact, TechStack, WeaviateConnConfig } from './types.js';
import { artifactContent } from './sdlc.js';

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

/** Map an SdlcArtifact to its Weaviate property bag. */
function artifactProps(a: SdlcArtifact): Record<string, unknown> {
  return {
    content: artifactContent(a),
    raw_body: a.body,
    artifact_id: a.artifact_id,
    title: a.title,
    kind: a.kind,
    status: a.status ?? '',
    source: a.source,
    project: a.project,
    tags: a.tags,
    author: a.author ?? '',
    url: a.url ?? '',
    links_json: JSON.stringify(a.links),
    link_rels: a.links.map((l) => l.rel),
    link_targets: a.links.map((l) => l.target),
    created_at: a.created_at ?? '',
    updated_at: a.updated_at ?? '',
  };
}

/**
 * Insert/replace SDLC artifacts. The deterministic `artifactUuid` means
 * re-inserting an artifact with the same (source, id) overwrites the prior
 * row cleanly — so callers can delete-by-source then insert, or just insert
 * to upsert in place.
 */
export async function insertArtifacts(
  client: WeaviateClient,
  artifacts: SdlcArtifact[],
): Promise<void> {
  if (artifacts.length === 0) return;
  const col = client.collections.get(SDLC_ARTIFACT);
  const BATCH = 200;
  for (let i = 0; i < artifacts.length; i += BATCH) {
    const slice = artifacts.slice(i, i + BATCH);
    await col.data.insertMany(
      slice.map((a) => ({
        id: artifactUuid(a.source, a.artifact_id),
        properties: artifactProps(a) as Record<string, never>,
      })),
    );
  }
}

/** Reconstruct an SdlcArtifact from a Weaviate property bag. */
function propsToArtifact(p: Record<string, unknown>): SdlcArtifact {
  let links: ArtifactLink[] = [];
  const raw = p['links_json'];
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) links = parsed as ArtifactLink[];
    } catch {
      // leave links empty on malformed JSON
    }
  }
  const a: SdlcArtifact = {
    artifact_id: String(p['artifact_id'] ?? ''),
    kind: (String(p['kind'] ?? 'other') || 'other') as SdlcArtifact['kind'],
    title: String(p['title'] ?? ''),
    body: String(p['raw_body'] ?? ''),
    source: String(p['source'] ?? ''),
    project: String(p['project'] ?? ''),
    links,
    tags: Array.isArray(p['tags']) ? (p['tags'] as string[]) : [],
  };
  const status = String(p['status'] ?? '');
  if (status) a.status = status;
  const author = String(p['author'] ?? '');
  if (author) a.author = author;
  const url = String(p['url'] ?? '');
  if (url) a.url = url;
  const createdAt = String(p['created_at'] ?? '');
  if (createdAt) a.created_at = createdAt;
  const updatedAt = String(p['updated_at'] ?? '');
  if (updatedAt) a.updated_at = updatedAt;
  return a;
}

export interface ListArtifactsFilter {
  project?: string;
  source?: string;
  kind?: string;
  status?: string;
  limit?: number;
}

/** List artifacts with optional metadata filters. No vector query — a scan. */
export async function listArtifacts(
  client: WeaviateClient,
  filter: ListArtifactsFilter = {},
): Promise<SdlcArtifact[]> {
  const col = client.collections.get(SDLC_ARTIFACT);
  const clauses = [
    filter.project ? col.filter.byProperty('project').equal(filter.project) : undefined,
    filter.source ? col.filter.byProperty('source').equal(filter.source) : undefined,
    filter.kind ? col.filter.byProperty('kind').equal(filter.kind) : undefined,
    filter.status ? col.filter.byProperty('status').equal(filter.status) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const filters =
    clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : Filters.and(...clauses);
  const res = await col.query.fetchObjects({
    limit: filter.limit ?? 5000,
    ...(filters ? { filters } : {}),
  });
  return res.objects.map((o) => propsToArtifact(o.properties as Record<string, unknown>));
}

/** Fetch a single artifact by (source, id). Returns undefined if absent. */
export async function getArtifact(
  client: WeaviateClient,
  source: string,
  artifactId: string,
): Promise<SdlcArtifact | undefined> {
  const col = client.collections.get(SDLC_ARTIFACT);
  const obj = await col.query.fetchObjectById(artifactUuid(source, artifactId));
  if (!obj) return undefined;
  return propsToArtifact(obj.properties as Record<string, unknown>);
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

export interface DecompositionInputs {
  /** file_path → defining module is computed by the caller; here we return raw rows. */
  files: { file_path: string; language: string }[];
  symbols: { name: string; file_path: string }[];
  edges: { file: string; callee: string }[];
}

/**
 * Fetch the raw inputs for monolith-decomposition analysis for one project:
 * the file inventory (from CodeChunk), the symbol→file index (SymbolRecord),
 * and the call edges (CallEdge). The pure analysis in
 * core/analysis/decomposition.ts turns these into a module graph.
 */
export async function fetchDecompositionInputs(
  client: WeaviateClient,
  project: string,
): Promise<DecompositionInputs> {
  const chunkCol = client.collections.get(CODE_CHUNK);
  const symCol = client.collections.get(SYMBOL_RECORD);
  const edgeCol = client.collections.get(CALL_EDGE);

  // Weaviate's QUERY_MAXIMUM_RESULTS defaults to 10000, so cap each fetch
  // there. Very large monorepos may truncate; pagination is a future refinement.
  const MAX = 10000;
  const [chunkRes, symRes, edgeRes] = await Promise.all([
    chunkCol.query.fetchObjects({
      filters: chunkCol.filter.byProperty('project').equal(project),
      limit: MAX,
      returnProperties: ['file_path', 'language'],
    }),
    symCol.query.fetchObjects({
      filters: symCol.filter.byProperty('project').equal(project),
      limit: MAX,
      returnProperties: ['name', 'file_path'],
    }),
    edgeCol.query.fetchObjects({
      filters: edgeCol.filter.byProperty('project').equal(project),
      limit: MAX,
      returnProperties: ['file', 'callee'],
    }),
  ]);

  // CodeChunk has many rows per file; dedupe to distinct files.
  const fileMap = new Map<string, string>();
  for (const o of chunkRes.objects) {
    const p = o.properties as Record<string, unknown>;
    const fp = String(p['file_path'] ?? '');
    if (fp && !fileMap.has(fp)) fileMap.set(fp, String(p['language'] ?? ''));
  }

  return {
    files: [...fileMap.entries()].map(([file_path, language]) => ({ file_path, language })),
    symbols: symRes.objects.map((o) => {
      const p = o.properties as Record<string, unknown>;
      return { name: String(p['name'] ?? ''), file_path: String(p['file_path'] ?? '') };
    }),
    edges: edgeRes.objects.map((o) => {
      const p = o.properties as Record<string, unknown>;
      return { file: String(p['file'] ?? ''), callee: String(p['callee'] ?? '') };
    }),
  };
}

/** Read every detected project tech stack. Used by modernization analysis. */
export async function listProjectStacks(client: WeaviateClient): Promise<TechStack[]> {
  const col = client.collections.get(PROJECT_STACK);
  const res = await col.query.fetchObjects({ limit: 1000 });
  return res.objects.map((obj) => {
    const p = obj.properties as Record<string, unknown>;
    const stack: TechStack = {
      project: String(p['project'] ?? ''),
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
  });
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
