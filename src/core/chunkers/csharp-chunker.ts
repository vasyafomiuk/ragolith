// C# chunker — regex/brace-counting based namespace / class / method splitter.
//
// Mirrors the Java chunker's strategy with namespaces as an extra outer level.
// Not a full parser; falls back to line-based chunking when nothing matches.

import { chunkFallback } from './chunker.js';
import type { ChunkResult } from '../types.js';

export interface CSharpOptions {
  filePath: string;
  project: string;
}

const NS_RE = /\bnamespace\s+([A-Za-z_][\w.]*)/g;
const TYPE_RE = /\b(?:public|internal|protected|private|abstract|sealed|static|partial|\s)*\b(class|struct|interface|record|enum)\s+([A-Za-z_]\w*)/g;
const METHOD_RE =
  /(?:public|internal|protected|private|static|virtual|override|sealed|async|partial|\s)+[\w<>,\s[\]?.]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g;

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
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === '\'') { inStr = c; continue; }
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

function extractTypes(
  source: string,
  baseOffset: number,
  parentNs: string | undefined,
  opts: CSharpOptions,
  out: ChunkResult,
): void {
  TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPE_RE.exec(source))) {
    const kindWord = m[1];
    const typeName = m[2];
    if (!kindWord || !typeName) continue;
    const absDecl = baseOffset + m.index;
    const openBrace = source.indexOf('{', TYPE_RE.lastIndex);
    if (openBrace < 0) break;
    const absOpen = baseOffset + openBrace;
    const end = findBraceEnd(source, openBrace);
    const absEnd = baseOffset + end;
    const body = source.slice(m.index, end + 1);

    const fullName = parentNs ? `${parentNs}.${typeName}` : typeName;
    out.symbols.push({
      name: typeName,
      kind: kindWord === 'interface' ? 'interface' : (kindWord === 'enum' ? 'enum' : 'class'),
      signature: body.split('{')[0]!.replace(/\s+/g, ' ').trim(),
      ...(parentNs ? { parent: parentNs } : {}),
      exports: true,
      file_path: opts.filePath,
      project: opts.project,
      start_line: lineAt(source, m.index) + (baseOffset > 0 ? 0 : 0),
      end_line: lineAt(source, end) + (baseOffset > 0 ? 0 : 0),
      language: 'csharp',
    });

    out.chunks.push({
      content: body,
      raw_content: body,
      file_path: opts.filePath,
      project: opts.project,
      start_line: lineAt(source.slice(0, source.length), m.index) + Math.max(0, baseOffset === 0 ? 0 : 0),
      end_line: lineAt(source, end),
      language: 'csharp',
      chunk_type: 'class',
      symbol: fullName,
    });

    const innerStart = openBrace + 1;
    const innerEnd = end;
    const inner = source.slice(innerStart, innerEnd);

    METHOD_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = METHOD_RE.exec(inner))) {
      const methodName = mm[1];
      if (!methodName) continue;
      const methodOpenInSource = innerStart + mm.index + mm[0].length - 1;
      const methodEndInSource = findBraceEnd(source, methodOpenInSource);
      const methodBody = source.slice(innerStart + mm.index, methodEndInSource + 1);
      const mStart = lineAt(source, innerStart + mm.index);
      const mEnd = lineAt(source, methodEndInSource);

      out.symbols.push({
        name: methodName,
        kind: 'method',
        signature: mm[0].replace(/\s+/g, ' ').replace(/\{$/, '').trim(),
        parent: fullName,
        exports: true,
        file_path: opts.filePath,
        project: opts.project,
        start_line: mStart,
        end_line: mEnd,
        language: 'csharp',
      });

      out.chunks.push({
        content: methodBody,
        raw_content: methodBody,
        file_path: opts.filePath,
        project: opts.project,
        start_line: mStart,
        end_line: mEnd,
        language: 'csharp',
        chunk_type: 'method',
        symbol: `${fullName}.${methodName}`,
      });
    }

    // Silence unused-var lints for offsets — they document intent for future extension.
    void absDecl; void absOpen; void absEnd;
  }
}

export function chunkCSharp(content: string, opts: CSharpOptions): ChunkResult {
  const out: ChunkResult = { chunks: [], symbols: [], edges: [] };

  // file-scoped namespace?  e.g. `namespace Foo;` — treat the whole file as inside that namespace.
  const fileScoped = /\bnamespace\s+([A-Za-z_][\w.]*)\s*;/.exec(content);
  if (fileScoped && fileScoped[1]) {
    extractTypes(content, 0, fileScoped[1], opts, out);
  } else {
    // Block-scoped namespaces.
    NS_RE.lastIndex = 0;
    let nm: RegExpExecArray | null;
    let consumed = false;
    while ((nm = NS_RE.exec(content))) {
      const nsName = nm[1];
      if (!nsName) continue;
      const openBrace = content.indexOf('{', NS_RE.lastIndex);
      if (openBrace < 0) continue;
      const end = findBraceEnd(content, openBrace);
      const inner = content.slice(openBrace + 1, end);
      extractTypes(inner, openBrace + 1, nsName, opts, out);
      consumed = true;
    }
    if (!consumed) extractTypes(content, 0, undefined, opts, out);
  }

  if (out.chunks.length === 0) {
    return chunkFallback(content, {
      filePath: opts.filePath,
      project: opts.project,
      language: 'csharp',
    });
  }

  return out;
}
