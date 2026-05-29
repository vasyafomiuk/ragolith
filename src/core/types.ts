// Shared types for ingest, search, and MCP layers.

export type ChunkType =
  | 'function'
  | 'class'
  | 'method'
  | 'namespace'
  | 'statement'
  | 'document'
  | 'fallback';

export type Language =
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'csharp'
  | 'sql'
  | 'python'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'markdown'
  | 'pdf'
  | 'docx'
  | 'text'
  | 'unknown';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'variable';

export type CallType = 'static' | 'method' | 'dynamic';

/** One chunk ready to be embedded and stored in Weaviate (CodeChunk collection). */
export interface CodeChunk {
  /** Content with optional project-context prefix prepended (the "prefixed content" embedded by Weaviate). */
  content: string;
  /** Raw chunk content without the prefix — useful when returning results to clients. */
  raw_content: string;
  file_path: string;
  project: string;
  /** Inclusive start line (1-based). */
  start_line: number;
  /** Inclusive end line (1-based). */
  end_line: number;
  language: Language;
  chunk_type: ChunkType;
  /** Name of the enclosing symbol if applicable (function/class). */
  symbol?: string;
  /** Commit SHA the chunk was ingested from. */
  commit_sha?: string;
}

/** One symbol entry for the SymbolRecord collection. */
export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  signature: string;
  /** Containing class/namespace, if any. */
  parent?: string;
  /** True if the symbol is exported from its file. */
  exports: boolean;
  file_path: string;
  project: string;
  start_line: number;
  end_line: number;
  language: Language;
}

/** One caller→callee relationship for the CallEdge collection (TS/JS only). */
export interface CallEdge {
  caller: string;
  callee: string;
  call_type: CallType;
  file: string;
  line: number;
  project: string;
}

/** Output of a chunker for a single file. */
export interface ChunkResult {
  chunks: CodeChunk[];
  symbols: SymbolRecord[];
  edges: CallEdge[];
}

/** A search hit returned to the MCP client. */
export interface SearchHit {
  content: string;
  file_path: string;
  project: string;
  start_line: number;
  end_line: number;
  language: Language;
  chunk_type: ChunkType;
  symbol?: string;
  score: number;
}

/** A search hit over the SDLC artifact index. */
export interface ArtifactHit {
  artifact_id: string;
  kind: SdlcArtifactKind;
  title: string;
  /** Excerpt of the artifact body. */
  excerpt: string;
  source: string;
  project: string;
  status?: string;
  url?: string;
  score: number;
}

/**
 * One indexable repository — git clone (`repo`) or local directory
 * (`localPath`). Walked respecting `.gitignore`, chunked by the
 * language-specific dispatcher. Incremental tracking is via last-ingested
 * commit SHA, stored in the ingest state file under `state.projects[name]`.
 */
export interface RepoConfig {
  name: string;
  repo?: string;
  /** Optional local path; takes precedence over repo if both are set. */
  localPath?: string;
  branch?: string;
  /** One repo entry can index multiple monorepo subdirectories. */
  subPaths?: string[];
  /** Token env var name; defaults to GIT_TOKEN. */
  tokenEnv?: string;
}

/**
 * One standalone document — read directly via the PDF/DOCX/UTF-8 reader, no
 * git involved. Incremental tracking is via mtime in
 * `state.files[name].mtime_ms`.
 */
export interface DocumentConfig {
  name: string;
  /** Absolute path to the document on disk. */
  path: string;
}

/**
 * @deprecated Use {@link RepoConfig}. Kept as an alias so callers that
 * imported the old name keep compiling; will be removed in a future major.
 */
export type ProjectConfig = RepoConfig;

/**
 * @deprecated Use {@link DocumentConfig}. Kept as an alias so callers that
 * imported the old name keep compiling; will be removed in a future major.
 */
export type FileConfig = DocumentConfig;

// --- SDLC artifacts --------------------------------------------------------
//
// ragolith indexes more than code: requirements, decisions, tickets, tests,
// runbooks, API specs — the whole software-development lifecycle. These arrive
// in a tool-agnostic interchange format (RSIF — see core/sdlc.ts) so ragolith
// never depends on Jira/Confluence/Linear/etc. APIs. Adapters convert vendor
// exports into RSIF; the format is the contract.

/**
 * The kind of SDLC artifact. Open-ended on purpose: anything unrecognized maps
 * to `other` rather than being rejected, so a new tool's export still indexes.
 */
export type SdlcArtifactKind =
  | 'requirement'
  | 'story'
  | 'epic'
  | 'feature'
  | 'decision' // ADR / design decision
  | 'ticket' // bug / task / issue
  | 'risk'
  | 'test_case'
  | 'runbook'
  | 'api_spec'
  | 'design_doc'
  | 'meeting_note'
  | 'incident'
  | 'other';

/**
 * How one artifact relates to another artifact or to code. The vocabulary is
 * deliberately small and bidirectional-aware so gap analysis can traverse it:
 * a requirement `implemented_by` code, code `tested_by` a test_case, a decision
 * that `supersedes` an earlier one. `target` is either another artifact's
 * `artifact_id` or a code reference like `repo:my-app/src/foo.ts` or
 * `symbol:my-app/PaymentService.charge`.
 */
export type ArtifactLinkRel =
  | 'implements'
  | 'implemented_by'
  | 'tests'
  | 'tested_by'
  | 'depends_on'
  | 'blocks'
  | 'blocked_by'
  | 'relates_to'
  | 'supersedes'
  | 'superseded_by'
  | 'derived_from'
  | 'refines'
  | 'mitigates'
  | 'parent_of'
  | 'child_of';

export interface ArtifactLink {
  rel: ArtifactLinkRel;
  /** Another artifact_id, or a `repo:`/`symbol:`/`file:` code reference. */
  target: string;
}

/**
 * One SDLC artifact, normalized from RSIF. The `body` is the searchable prose;
 * everything else is filterable metadata. `source` names the system of record
 * (free-form: "jira", "confluence", "github", "local", …) so the index stays
 * tool-agnostic.
 */
export interface SdlcArtifact {
  /** Stable id, unique within a source. e.g. "PROJ-123", "ADR-0007". */
  artifact_id: string;
  kind: SdlcArtifactKind;
  title: string;
  /** Markdown / plain-text prose. Chunked + embedded for search. */
  body: string;
  /** Lifecycle status, free-form: "open", "in_progress", "done", "deprecated". */
  status?: string;
  /** System of record this came from. Free-form, lowercased by convention. */
  source: string;
  /** Logical product/project this belongs to — ties into the repo `project`. */
  project: string;
  links: ArtifactLink[];
  tags: string[];
  /** Original author / reporter, if known. */
  author?: string;
  /** Back-link to the artifact in its source system. */
  url?: string;
  /** ISO timestamps if known. */
  created_at?: string;
  updated_at?: string;
}

/**
 * One SDLC source to ingest. Points at a directory of RSIF files (`.md` /
 * `.ndjson` / `.jsonl`) or a single such file. `source` labels every artifact
 * read from it (overridable per-artifact in the file). Incremental tracking is
 * via mtime, stored in `state.sdlc[name]`.
 */
export interface SdlcSourceConfig {
  name: string;
  /** Absolute path to a directory of RSIF files, or a single RSIF file. */
  path: string;
  /** Default `source` label for artifacts that don't declare their own. */
  source?: string;
  /** Default `project` for artifacts that don't declare their own. */
  project?: string;
}

export interface WeaviateConnConfig {
  host: string;
  httpPort: number;
  grpcPort: number;
  secure: boolean;
  apiKey?: string;
}

export interface IngestConfig {
  workDir: string;
  stateFile: string;
  extensions: string[];
  maxFileBytes: number;
}

export interface SearchConfig {
  overFetch: number;
  diversityPerFile: number;
  rerankerEnabled: boolean;
}

export interface BackupConfig {
  backend: 'filesystem' | 's3';
  s3?: {
    bucket: string;
    region: string;
    prefix?: string;
  };
}

export interface RagolithConfig {
  weaviate: WeaviateConnConfig;
  ingest: IngestConfig;
  search: SearchConfig;
  /** Git repositories (or local directories of code) to index. */
  repos: RepoConfig[];
  /** Standalone documents (PDF / DOCX / TXT / MD) to index. */
  documents: DocumentConfig[];
  /** SDLC artifact sources (RSIF directories/files) to index. */
  sdlc: SdlcSourceConfig[];
  backup: BackupConfig;
}

/** Persistent state: last-ingested commit per project. */
export interface IngestState {
  projects: Record<string, { commit_sha: string; updated_at: string }>;
  files: Record<string, { mtime_ms: number; updated_at: string }>;
  /** Per-SDLC-source last-ingest marker (mtime of newest file seen). */
  sdlc?: Record<string, { mtime_ms: number; updated_at: string; count: number }>;
}

/** The kind of manifest file a dependency entry came from. */
export type ManifestType = 'npm' | 'maven' | 'gradle' | 'pip' | 'poetry' | 'nuget';

/**
 * One detected framework / library — the curated, opinionated subset of a
 * project's dependencies (Spring Boot, React, Django, etc.). The `source`
 * field points at the manifest file the entry came from, so an LLM can tell
 * which subPath / build unit owns it in a monorepo.
 */
export interface DetectedFramework {
  name: string;
  version: string;
  source: string;
}

/**
 * The project-level tech-stack record, persisted to the ProjectStack
 * Weaviate collection and surfaced verbatim by the `tech_stack` MCP tool.
 *
 * Detection happens during ingest by parsing manifests (package.json,
 * pom.xml, build.gradle[.kts], requirements.txt, pyproject.toml, *.csproj)
 * at the repo root and in each declared subPath.
 */
export interface TechStack {
  project: string;
  /** Languages observed across all manifests, e.g. ['java', 'kotlin']. */
  languages: string[];
  /** Build / package tools, e.g. ['maven', 'gradle']. */
  build_tools: ManifestType[];
  /** Runtime version constraints declared by the project, e.g. { java: '17', node: '>=20' }. */
  runtimes: Record<string, string>;
  /** Curated frameworks (Spring Boot, React, Django, ...) detected via allowlist. */
  frameworks: DetectedFramework[];
  /** Every manifest the scanner successfully read, for traceability. */
  manifests: { path: string; type: ManifestType }[];
  /** ISO timestamp of detection. */
  detected_at: string;
  /** Commit SHA the detection was performed against, if available. */
  commit_sha?: string;
}
