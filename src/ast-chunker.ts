// TS/JS chunker using the TypeScript compiler API.
//
// - Splits at function / class / method / interface / type / enum boundaries.
// - Emits SymbolRecord entries for every top-level + class-member declaration.
// - Emits CallEdge entries by walking CallExpressions inside each function body.
// - Falls back to the line-based chunker on parse failure.

import ts from 'typescript';
import { chunkFallback } from './chunker.js';
import type {
  CallEdge,
  CallType,
  ChunkResult,
  CodeChunk,
  Language,
  SymbolKind,
  SymbolRecord,
} from './types.js';

export interface AstOptions {
  filePath: string;
  project: string;
  language: Language; // 'typescript' | 'javascript'
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function signatureOf(node: ts.Node, source: ts.SourceFile): string {
  // First line up to the opening brace — close enough for an index and avoids embedding bodies.
  const text = node.getText(source);
  const brace = text.indexOf('{');
  const head = brace > 0 ? text.slice(0, brace) : text;
  return head.replace(/\s+/g, ' ').trim();
}

function kindFor(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  return undefined;
}

function chunkTypeFor(kind: SymbolKind): CodeChunk['chunk_type'] {
  if (kind === 'class') return 'class';
  if (kind === 'method') return 'method';
  if (kind === 'namespace') return 'namespace';
  return 'function';
}

function nameOf(node: ts.Node): string | undefined {
  const named = node as ts.NamedDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  if (named.name && ts.isStringLiteral(named.name)) return named.name.text;
  return undefined;
}

interface CallContext {
  caller: string;
  edges: CallEdge[];
  project: string;
  filePath: string;
  source: ts.SourceFile;
}

function callTypeFor(expr: ts.CallExpression): CallType {
  if (ts.isPropertyAccessExpression(expr.expression)) return 'method';
  if (ts.isIdentifier(expr.expression)) return 'static';
  return 'dynamic';
}

function calleeName(expr: ts.CallExpression): string | undefined {
  const e = expr.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return undefined;
}

function walkCalls(node: ts.Node, ctx: CallContext): void {
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node);
    if (callee) {
      ctx.edges.push({
        caller: ctx.caller,
        callee,
        call_type: callTypeFor(node),
        file: ctx.filePath,
        line: lineOf(ctx.source, node.getStart(ctx.source)),
        project: ctx.project,
      });
    }
  }
  node.forEachChild((child) => walkCalls(child, ctx));
}

export function chunkAst(content: string, opts: AstOptions): ChunkResult {
  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(
      opts.filePath,
      content,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      opts.language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
  } catch {
    return chunkFallback(content, {
      filePath: opts.filePath,
      project: opts.project,
      language: opts.language,
    });
  }

  const chunks: CodeChunk[] = [];
  const symbols: SymbolRecord[] = [];
  const edges: CallEdge[] = [];

  const emit = (node: ts.Node, parent: string | undefined): void => {
    const kind = kindFor(node);
    if (!kind) return;
    const name = nameOf(node);
    if (!name) return;

    const startLine = lineOf(source, node.getStart(source));
    const endLine = lineOf(source, node.getEnd());
    const text = node.getText(source);

    symbols.push({
      name,
      kind,
      signature: signatureOf(node, source),
      ...(parent ? { parent } : {}),
      exports: isExported(node),
      file_path: opts.filePath,
      project: opts.project,
      start_line: startLine,
      end_line: endLine,
      language: opts.language,
    });

    chunks.push({
      content: text,
      raw_content: text,
      file_path: opts.filePath,
      project: opts.project,
      start_line: startLine,
      end_line: endLine,
      language: opts.language,
      chunk_type: chunkTypeFor(kind),
      symbol: parent ? `${parent}.${name}` : name,
    });

    if (kind === 'function' || kind === 'method') {
      walkCalls(node, {
        caller: parent ? `${parent}.${name}` : name,
        edges,
        project: opts.project,
        filePath: opts.filePath,
        source,
      });
    }

    if (kind === 'class' || kind === 'namespace' || kind === 'interface') {
      node.forEachChild((child) => emit(child, name));
    }
  };

  source.forEachChild((node) => emit(node, undefined));

  // If nothing structural was found (e.g. a script of top-level statements), fall back.
  if (chunks.length === 0) {
    return chunkFallback(content, {
      filePath: opts.filePath,
      project: opts.project,
      language: opts.language,
    });
  }

  return { chunks, symbols, edges };
}
