// SQL chunker — splits at statement boundaries.
//
// Statements are terminated by `;` outside of string literals and comments.
// Each non-empty statement becomes its own chunk, which keeps SELECTs, DDL, and
// stored procedures cleanly separated.

import { chunkFallback } from './chunker.js';
import type { ChunkResult, CodeChunk } from './types.js';

export interface SqlOptions {
  filePath: string;
  project: string;
}

function splitStatements(src: string): { text: string; startLine: number; endLine: number }[] {
  const out: { text: string; startLine: number; endLine: number }[] = [];
  let buf = '';
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let line = 1;
  let stmtStartLine = 1;

  const flush = (endLine: number): void => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) {
      out.push({ text: trimmed, startLine: stmtStartLine, endLine });
    }
    buf = '';
    stmtStartLine = endLine + (buf.length === 0 ? 0 : 0);
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') line++;

    if (inLineComment) {
      buf += c;
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === '*' && next === '/') { buf += next; inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      buf += c;
      if (c === '\\') { if (next !== undefined) { buf += next; i++; } continue; }
      if (c === inStr) inStr = null;
      continue;
    }

    if (c === '-' && next === '-') { inLineComment = true; buf += c; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; buf += c; continue; }
    if (c === '\'' || c === '"' || c === '`') { inStr = c; buf += c; continue; }

    if (c === ';') {
      buf += c;
      flush(line);
      stmtStartLine = line + (next === '\n' ? 1 : 0);
      continue;
    }

    buf += c;
  }
  flush(line);
  return out;
}

export function chunkSql(content: string, opts: SqlOptions): ChunkResult {
  const stmts = splitStatements(content);
  if (stmts.length === 0) {
    return chunkFallback(content, {
      filePath: opts.filePath,
      project: opts.project,
      language: 'sql',
    });
  }

  const chunks: CodeChunk[] = stmts.map((s) => ({
    content: s.text,
    raw_content: s.text,
    file_path: opts.filePath,
    project: opts.project,
    start_line: s.startLine,
    end_line: s.endLine,
    language: 'sql',
    chunk_type: 'statement',
  }));

  return { chunks, symbols: [], edges: [] };
}
