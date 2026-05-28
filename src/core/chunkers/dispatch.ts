// Chunker dispatch — picks the right chunker for a language.
//
// Lives in core/ because both the ingest CLI and (in the future) any other
// transport that drives ingestion should reach for the same dispatch logic.

import type { ChunkResult, Language } from '../types.js';
import { chunkAst } from './ast-chunker.js';
import { chunkSql } from './sql-chunker.js';
import { chunkFallback } from './chunker.js';
import { chunkLanguageWithFallback, type GrammarName } from './tree-sitter.js';

export interface DispatchArgs {
  content: string;
  filePath: string;
  project: string;
  language: Language;
}

// Languages handled by tree-sitter (real AST walk per grammar). All seven
// share the same chunkLanguageWithFallback wrapper — the per-language
// node-type sets live in tree-sitter.ts.
const TREE_SITTER_GRAMMARS: Partial<Record<Language, GrammarName>> = {
  java: 'java',
  csharp: 'csharp',
  python: 'python',
  go: 'go',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
};

export async function pickChunker(args: DispatchArgs): Promise<ChunkResult> {
  const { content, filePath, project, language } = args;

  // TS/JS: TypeScript compiler API — emits call edges in addition to symbols.
  if (language === 'typescript' || language === 'javascript') {
    return chunkAst(content, { filePath, project, language });
  }

  // SQL: statement-boundary split.
  if (language === 'sql') {
    return chunkSql(content, { filePath, project });
  }

  // Tree-sitter languages.
  const grammar = TREE_SITTER_GRAMMARS[language];
  if (grammar) {
    return chunkLanguageWithFallback(content, { filePath, project, language }, grammar);
  }

  // Markdown, text, PDF, DOCX, unknown — line-based fallback.
  return chunkFallback(content, { filePath, project, language });
}
