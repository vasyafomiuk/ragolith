// Barrel for the chunkers sub-layer. Importing from `core/chunkers` gives you
// the individual chunkers plus the dispatch function — no caller should reach
// inside the directory for a specific file.

export { chunkFallback, applyProjectPrefix, type FallbackOptions } from './chunker.js';
export { chunkAst, type AstOptions } from './ast-chunker.js';
export { chunkSql, type SqlOptions } from './sql-chunker.js';
export { pickChunker, type DispatchArgs } from './dispatch.js';
