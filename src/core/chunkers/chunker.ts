// Fallback line-based chunker — used when no language-specific chunker applies,
// or when an AST parse fails. ~4000 chars per chunk with 4-line overlap so a
// function that straddles a boundary still appears in both chunks.

import type { ChunkResult, CodeChunk, Language } from '../types.js';

const TARGET_CHARS = 4000;
const OVERLAP_LINES = 4;

export interface FallbackOptions {
  filePath: string;
  project: string;
  language: Language;
  /** Optional symbol name attached to every chunk (used by chunkers that pre-split). */
  symbol?: string;
  /** Line offset added to all chunk line numbers (1-based). Defaults to 1. */
  startLine?: number;
}

export function chunkFallback(content: string, opts: FallbackOptions): ChunkResult {
  const lines = content.split('\n');
  const chunks: CodeChunk[] = [];
  const lineOffset = opts.startLine ?? 1;

  let i = 0;
  while (i < lines.length) {
    let chars = 0;
    let j = i;
    while (j < lines.length && chars < TARGET_CHARS) {
      chars += (lines[j]?.length ?? 0) + 1;
      j++;
    }
    const body = lines.slice(i, j).join('\n');
    if (body.trim().length > 0) {
      const chunk: CodeChunk = {
        content: body,
        raw_content: body,
        file_path: opts.filePath,
        project: opts.project,
        start_line: lineOffset + i,
        end_line: lineOffset + j - 1,
        language: opts.language,
        chunk_type: 'fallback',
      };
      if (opts.symbol) chunk.symbol = opts.symbol;
      chunks.push(chunk);
    }
    if (j >= lines.length) break;
    i = Math.max(j - OVERLAP_LINES, i + 1);
  }

  return { chunks, symbols: [], edges: [] };
}

/** Prepend a project-context prefix to every chunk's embedded `content`. */
export function applyProjectPrefix(result: ChunkResult, project: string): ChunkResult {
  const prefixed: CodeChunk[] = result.chunks.map((c) => ({
    ...c,
    content: `[project:${project}] [file:${c.file_path}] ${c.symbol ? `[symbol:${c.symbol}] ` : ''}${c.raw_content}`,
  }));
  return { ...result, chunks: prefixed };
}
