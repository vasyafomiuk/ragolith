// Tree-sitter-based chunker for Java and C#.
//
// Replaces the regex+brace-counter implementations with a real AST walk per
// language. Catches things the regex misses: annotations, generic signatures,
// nested classes, records, primary constructors, file-scoped namespaces.
//
// Falls back to the legacy regex chunker if WASM init or parsing fails (e.g.
// in a constrained runtime). Callers don't need to special-case the fallback —
// the public chunkJava / chunkCSharp functions wrap it.
//
// Runtime cost: ~200ms one-time init (load WASM + Parser.init). Subsequent
// parses are sub-millisecond. The Language + Parser are cached at module scope.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
// web-tree-sitter 0.22.x ships a CommonJS export with the Parser class as the
// default and Language as a static property. The TS types live under the
// 'Parser' namespace.
import Parser from 'web-tree-sitter';
import type {
  ChunkResult,
  CodeChunk,
  Language as RagolithLanguage,
  SymbolKind,
  SymbolRecord,
} from '../types.js';

type Node = Parser.SyntaxNode;
type Language = Parser.Language;

const require_ = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

type GrammarName = 'java' | 'csharp';

const grammarCache = new Map<GrammarName, Language>();

async function loadGrammar(name: GrammarName): Promise<Language> {
  const cached = grammarCache.get(name);
  if (cached) return cached;
  await ensureInit();
  // tree-sitter-wasms ships pre-built wasms next to its package.json. The C#
  // file is named with an underscore in this package.
  const wasmFile = name === 'csharp' ? 'tree-sitter-c_sharp.wasm' : 'tree-sitter-java.wasm';
  const wasmPath = require_.resolve(`tree-sitter-wasms/out/${wasmFile}`);
  const bytes = await readFile(wasmPath);
  const lang = await Parser.Language.load(bytes);
  grammarCache.set(name, lang);
  return lang;
}

export interface TreeSitterChunkOptions {
  filePath: string;
  project: string;
  language: RagolithLanguage;
}

// --- node type sets --------------------------------------------------------

interface TypeSets {
  containers: Set<string>; // class/struct/interface/enum/record — they contain method declarations
  methods: Set<string>; // method-shaped declarations whose name we surface as `parent.name`
  namespaces: Set<string>; // C# block + file-scoped namespaces
}

const JAVA: TypeSets = {
  containers: new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'annotation_type_declaration',
  ]),
  methods: new Set(['method_declaration', 'constructor_declaration']),
  namespaces: new Set(),
};

const CSHARP: TypeSets = {
  containers: new Set([
    'class_declaration',
    'struct_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'record_struct_declaration',
  ]),
  methods: new Set(['method_declaration', 'constructor_declaration', 'destructor_declaration']),
  namespaces: new Set(['namespace_declaration', 'file_scoped_namespace_declaration']),
};

function kindFromContainer(type: string): SymbolKind {
  if (type === 'interface_declaration') return 'interface';
  if (type === 'enum_declaration') return 'enum';
  if (type === 'class_declaration' || type === 'struct_declaration') return 'class';
  if (type === 'record_declaration' || type === 'record_struct_declaration') return 'class';
  if (type === 'annotation_type_declaration') return 'interface';
  return 'class';
}

function chunkTypeForKind(kind: SymbolKind): CodeChunk['chunk_type'] {
  if (kind === 'class') return 'class';
  if (kind === 'namespace') return 'namespace';
  return 'class';
}

// --- node helpers ----------------------------------------------------------

function nodeName(node: Node): string | undefined {
  // Most declarations expose `name` as a named field.
  const name = node.childForFieldName('name');
  if (name) return name.text;
  // Some grammars (older) put the identifier as the first named child of type identifier.
  for (const child of node.namedChildren) {
    if (child && (child.type === 'identifier' || child.type === 'type_identifier')) {
      return child.text;
    }
  }
  return undefined;
}

function signatureOf(node: Node): string {
  // Use the source up to the body's opening brace. If we can't find a body
  // child, return the whole node text — long, but at least correct.
  const text = node.text;
  const brace = text.indexOf('{');
  const head = brace > 0 ? text.slice(0, brace) : text;
  return head.replace(/\s+/g, ' ').trim();
}

function isExportedJava(node: Node): boolean {
  // In Java, anything that compiles at the top level is reachable from its
  // package. We can be more precise by looking for `public` in the modifiers
  // child, but for the index a coarse 'exports = true' is fine.
  const modifiers = node.childForFieldName('modifiers');
  if (!modifiers) return false;
  return /\bpublic\b/.test(modifiers.text);
}

function isExportedCSharp(node: Node): boolean {
  // C# modifiers child is a separate node sequence.
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'modifier' || child.type === 'modifiers') {
      if (/\bpublic\b/.test(child.text)) return true;
    }
  }
  return false;
}

// --- walker ---------------------------------------------------------------

interface WalkCtx {
  language: RagolithLanguage;
  ragolithLanguage: RagolithLanguage;
  types: TypeSets;
  opts: TreeSitterChunkOptions;
  out: ChunkResult;
  exportedCheck: (n: Node) => boolean;
}

function walkChildren(node: Node, parent: string | undefined, ctx: WalkCtx): void {
  for (const child of node.namedChildren) {
    if (child) walk(child, parent, ctx);
  }
}

function walk(node: Node, parent: string | undefined, ctx: WalkCtx): void {
  const { types, opts, out, exportedCheck } = ctx;

  if (types.namespaces.has(node.type)) {
    const name = nodeName(node);
    if (!name) {
      walkChildren(node, parent, ctx);
      return;
    }
    const fullName = parent ? `${parent}.${name}` : name;
    // We don't emit chunks for namespaces (they're often huge and not
    // useful as a single retrieval unit), but we do emit a SymbolRecord and
    // descend into the body with the namespace as parent context.
    out.symbols.push({
      name,
      kind: 'namespace',
      signature: signatureOf(node),
      ...(parent ? { parent } : {}),
      exports: true,
      file_path: opts.filePath,
      project: opts.project,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      language: ctx.ragolithLanguage,
    });
    // For namespace bodies we want to descend through everything (including
    // child namespaces). The body lives under field `body` for block
    // namespaces; file-scoped namespaces have content as sibling nodes.
    const body = node.childForFieldName('body');
    if (body) walkChildren(body, fullName, ctx);
    else {
      // File-scoped namespace: continue walking siblings under this name.
      // tree-sitter exposes the file-scoped body as direct children of the node.
      walkChildren(node, fullName, ctx);
    }
    return;
  }

  if (types.containers.has(node.type)) {
    const name = nodeName(node);
    if (!name) {
      walkChildren(node, parent, ctx);
      return;
    }
    const fullName = parent ? `${parent}.${name}` : name;
    const kind = kindFromContainer(node.type);

    const symbol: SymbolRecord = {
      name,
      kind,
      signature: signatureOf(node),
      ...(parent ? { parent } : {}),
      exports: exportedCheck(node),
      file_path: opts.filePath,
      project: opts.project,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      language: ctx.ragolithLanguage,
    };
    out.symbols.push(symbol);

    const chunk: CodeChunk = {
      content: node.text,
      raw_content: node.text,
      file_path: opts.filePath,
      project: opts.project,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      language: ctx.ragolithLanguage,
      chunk_type: chunkTypeForKind(kind),
      symbol: fullName,
    };
    out.chunks.push(chunk);

    // Descend for methods + nested types. Java/C# both expose the inner
    // block as field `body`; some grammars name it `body` or wrap it in
    // a class_body / enum_body / record_body node.
    const body = node.childForFieldName('body');
    if (body) walkChildren(body, fullName, ctx);
    else walkChildren(node, fullName, ctx);
    return;
  }

  if (types.methods.has(node.type)) {
    const name = nodeName(node);
    if (!name) {
      walkChildren(node, parent, ctx);
      return;
    }
    const fullName = parent ? `${parent}.${name}` : name;
    out.symbols.push({
      name,
      kind: 'method',
      signature: signatureOf(node),
      ...(parent ? { parent } : {}),
      exports: exportedCheck(node),
      file_path: opts.filePath,
      project: opts.project,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      language: ctx.ragolithLanguage,
    });
    out.chunks.push({
      content: node.text,
      raw_content: node.text,
      file_path: opts.filePath,
      project: opts.project,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      language: ctx.ragolithLanguage,
      chunk_type: 'method',
      symbol: fullName,
    });
    return;
  }

  // Everything else: keep descending.
  walkChildren(node, parent, ctx);
}

// --- public entry ----------------------------------------------------------

export async function chunkWithTreeSitter(
  content: string,
  opts: TreeSitterChunkOptions,
  grammar: GrammarName,
): Promise<ChunkResult> {
  const lang = await loadGrammar(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  if (!tree) throw new Error(`tree-sitter parse returned null for ${opts.filePath}`);

  const result: ChunkResult = { chunks: [], symbols: [], edges: [] };
  const types = grammar === 'java' ? JAVA : CSHARP;
  const ctx: WalkCtx = {
    language: opts.language,
    ragolithLanguage: opts.language,
    types,
    opts,
    out: result,
    exportedCheck: grammar === 'java' ? isExportedJava : isExportedCSharp,
  };

  walkChildren(tree.rootNode, undefined, ctx);
  tree.delete();
  return result;
}
