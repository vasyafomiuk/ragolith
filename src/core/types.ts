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
  backup: BackupConfig;
}

/** Persistent state: last-ingested commit per project. */
export interface IngestState {
  projects: Record<string, { commit_sha: string; updated_at: string }>;
  files: Record<string, { mtime_ms: number; updated_at: string }>;
}
