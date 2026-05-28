// Java chunker — regex/brace-counting based class & method splitter.
//
// Not a full parser. It identifies top-level class declarations and then walks
// brace-matched bodies to extract methods. Good enough for indexing; falls back
// to line-based chunking for content outside any class.

import { chunkFallback } from './chunker.js';
import type { ChunkResult, CodeChunk, SymbolRecord } from '../types.js';

export interface JavaOptions {
  filePath: string;
  project: string;
}

const CLASS_RE =
  /\b(?:public|protected|private|abstract|final|static|\s)*\b(class|interface|enum)\s+([A-Za-z_]\w*)/g;
const METHOD_RE =
  /(?:public|protected|private|static|final|synchronized|abstract|native|\s)+[\w<>,\s[\]?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws[^{;]+)?\s*\{/g;

function findBraceEnd(src: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

function lineAt(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

export function chunkJava(content: string, opts: JavaOptions): ChunkResult {
  const chunks: CodeChunk[] = [];
  const symbols: SymbolRecord[] = [];

  let m: RegExpExecArray | null;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(content))) {
    const kindWord = m[1];
    const name = m[2];
    if (!kindWord || !name) continue;
    const declStart = m.index;
    const openBrace = content.indexOf('{', CLASS_RE.lastIndex);
    if (openBrace < 0) break;
    const endBrace = findBraceEnd(content, openBrace);
    const body = content.slice(declStart, endBrace + 1);

    const startLine = lineAt(content, declStart);
    const endLine = lineAt(content, endBrace);

    symbols.push({
      name,
      kind: kindWord === 'interface' ? 'interface' : kindWord === 'enum' ? 'enum' : 'class',
      signature: body.split('{')[0]!.replace(/\s+/g, ' ').trim(),
      exports: true, // top-level Java declarations are visible to the package.
      file_path: opts.filePath,
      project: opts.project,
      start_line: startLine,
      end_line: endLine,
      language: 'java',
    });

    chunks.push({
      content: body,
      raw_content: body,
      file_path: opts.filePath,
      project: opts.project,
      start_line: startLine,
      end_line: endLine,
      language: 'java',
      chunk_type: 'class',
      symbol: name,
    });

    // Methods inside this class body.
    const innerStart = openBrace + 1;
    const inner = content.slice(innerStart, endBrace);
    METHOD_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = METHOD_RE.exec(inner))) {
      const methodName = mm[1];
      if (!methodName) continue;
      const absOpen = innerStart + mm.index + mm[0].length - 1;
      const absEnd = findBraceEnd(content, absOpen);
      const methodBody = content.slice(innerStart + mm.index, absEnd + 1);
      const mStart = lineAt(content, innerStart + mm.index);
      const mEnd = lineAt(content, absEnd);

      symbols.push({
        name: methodName,
        kind: 'method',
        signature: mm[0].replace(/\s+/g, ' ').replace(/\{$/, '').trim(),
        parent: name,
        exports: true,
        file_path: opts.filePath,
        project: opts.project,
        start_line: mStart,
        end_line: mEnd,
        language: 'java',
      });

      chunks.push({
        content: methodBody,
        raw_content: methodBody,
        file_path: opts.filePath,
        project: opts.project,
        start_line: mStart,
        end_line: mEnd,
        language: 'java',
        chunk_type: 'method',
        symbol: `${name}.${methodName}`,
      });
    }
  }

  if (chunks.length === 0) {
    return chunkFallback(content, {
      filePath: opts.filePath,
      project: opts.project,
      language: 'java',
    });
  }

  return { chunks, symbols, edges: [] };
}
