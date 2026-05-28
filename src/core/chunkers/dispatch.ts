// Chunker dispatch — picks the right chunker for a language.
//
// Lives in core/ because both the ingest CLI and (in the future) any other
// transport that drives ingestion should reach for the same dispatch logic.

import type { ChunkResult, Language } from '../types.js';
import { chunkAst } from './ast-chunker.js';
import { chunkJava } from './java-chunker.js';
import { chunkCSharp } from './csharp-chunker.js';
import { chunkSql } from './sql-chunker.js';
import { chunkFallback } from './chunker.js';

export interface DispatchArgs {
  content: string;
  filePath: string;
  project: string;
  language: Language;
}

export function pickChunker(args: DispatchArgs): ChunkResult {
  const { content, filePath, project, language } = args;
  switch (language) {
    case 'typescript':
    case 'javascript':
      return chunkAst(content, { filePath, project, language });
    case 'java':
      return chunkJava(content, { filePath, project });
    case 'csharp':
      return chunkCSharp(content, { filePath, project });
    case 'sql':
      return chunkSql(content, { filePath, project });
    default:
      return chunkFallback(content, { filePath, project, language });
  }
}
