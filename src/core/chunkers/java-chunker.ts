// Java chunker.
//
// Primary path: tree-sitter via web-tree-sitter + the Java grammar from
// tree-sitter-wasms. Real AST walk → annotations, generics, nested classes,
// records, lambdas all handled correctly.
//
// Fallback path: when tree-sitter cannot parse the file at all (init failure,
// malformed grammar load, etc), we fall through to the language-agnostic
// line-based chunker so ingest still produces *something* searchable.

import { chunkFallback } from './chunker.js';
import { chunkWithTreeSitter } from './tree-sitter.js';
import type { ChunkResult } from '../types.js';

export interface JavaOptions {
  filePath: string;
  project: string;
}

export async function chunkJava(content: string, opts: JavaOptions): Promise<ChunkResult> {
  try {
    const result = await chunkWithTreeSitter(
      content,
      { filePath: opts.filePath, project: opts.project, language: 'java' },
      'java',
    );
    if (result.chunks.length > 0) return result;
    // Tree-sitter parsed cleanly but found nothing structural (comment-only
    // file, stray statements, etc). Fall through to the line-based chunker.
  } catch {
    // WASM load failed or runtime threw. Fall through.
  }
  return chunkFallback(content, {
    filePath: opts.filePath,
    project: opts.project,
    language: 'java',
  });
}
