// C# chunker.
//
// Primary path: tree-sitter via web-tree-sitter + the C# grammar from
// tree-sitter-wasms. Real AST walk handles attributes, file-scoped namespaces,
// nested classes, records with primary constructors, expression-bodied methods,
// generics, and everything else the previous regex pass would have to guess at.
//
// Fallback path: when tree-sitter can't parse at all, we fall through to the
// language-agnostic line-based chunker so ingest still indexes something.

import { chunkFallback } from './chunker.js';
import { chunkWithTreeSitter } from './tree-sitter.js';
import type { ChunkResult } from '../types.js';

export interface CSharpOptions {
  filePath: string;
  project: string;
}

export async function chunkCSharp(content: string, opts: CSharpOptions): Promise<ChunkResult> {
  try {
    const result = await chunkWithTreeSitter(
      content,
      { filePath: opts.filePath, project: opts.project, language: 'csharp' },
      'csharp',
    );
    if (result.chunks.length > 0) return result;
  } catch {
    // WASM load or runtime failure — fall through to the line-based chunker.
  }
  return chunkFallback(content, {
    filePath: opts.filePath,
    project: opts.project,
    language: 'csharp',
  });
}
