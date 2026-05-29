// Tree-sitter-based chunker. Single entry point for every grammar we ship.
//
// Adding a new language is a four-step exercise:
//   1. Make sure the wasm exists under tree-sitter-wasms/out/.
//   2. Add the grammar name to GrammarName + WASM_FILE.
//   3. Define TypeSets for it in GRAMMARS — the node types that count as
//      containers (classes/interfaces/structs/...), methods, functions,
//      and namespaces.
//   4. Add a dispatch case in src/core/chunkers/dispatch.ts.
//
// Runtime cost: ~200ms one-time init (load WASM + Parser.init). Subsequent
// parses are sub-millisecond. The Language + Parser are cached at module scope.
//
// Pinned to web-tree-sitter 0.22.x because the WASMs in tree-sitter-wasms
// 0.1.13 are built against that ABI; web-tree-sitter 0.26.x's loader rejects
// them with a cryptic dylink-metadata error.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { chunkFallback } from './chunker.js';
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

export type GrammarName = 'java' | 'csharp' | 'python' | 'go' | 'rust' | 'ruby' | 'php';

const WASM_FILE: Record<GrammarName, string> = {
  java: 'tree-sitter-java.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
};

const grammarCache = new Map<GrammarName, Language>();

async function loadGrammar(name: GrammarName): Promise<Language> {
  const cached = grammarCache.get(name);
  if (cached) return cached;
  await ensureInit();
  const wasmPath = require_.resolve(`tree-sitter-wasms/out/${WASM_FILE[name]}`);
  const bytes = await readFile(wasmPath);
  const lang = await Parser.Language.load(bytes);
  grammarCache.set(name, lang);
  return lang;
}

// --- node type sets --------------------------------------------------------

interface CallSpec {
  /** AST node types that represent a call/invocation. */
  types: Set<string>;
  /** Extract the callee's simple name + whether it was via a receiver (obj.m()). */
  extract: (call: Node) => { name: string; viaMember: boolean } | undefined;
}

interface TypeSets {
  /** Container declarations — emit chunk + symbol, descend into body for nested decls. */
  containers: Set<string>;
  /** Method-shaped declarations — always emit kind='method'. */
  methods: Set<string>;
  /** Function-shaped declarations — kind='method' if inside a container, else 'function'. */
  functions: Set<string>;
  /** Namespace-shaped declarations — emit symbol only (no chunk), descend with qualified name. */
  namespaces: Set<string>;
  /** How to compute the SymbolKind for a container node. */
  containerKind: (type: string) => SymbolKind;
  /**
   * Optional call-edge extraction. When set, calls inside method/function
   * bodies become CallEdge records (powering callers_of/callees_of and the
   * decomposition graph). Only defined for grammars where it's reliable.
   */
  calls?: CallSpec;
}

/** Rightmost simple identifier of a (possibly generic) name node. */
function simpleName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node.type === 'identifier') return node.text;
  // generic_name (C#) / generic types: take the leading identifier child.
  const id = node.namedChildren.find((c) => c?.type === 'identifier');
  if (id) return id.text;
  // Fall back to text before any generic/`<` marker.
  const t = node.text.split('<')[0]?.trim();
  return t || undefined;
}

/** C# `invocation_expression` → callee name. */
function csharpCallee(call: Node): { name: string; viaMember: boolean } | undefined {
  const fn = call.childForFieldName('function') ?? call.namedChildren[0] ?? null;
  if (!fn) return undefined;
  if (fn.type === 'member_access_expression') {
    const name = simpleName(fn.childForFieldName('name'));
    return name ? { name, viaMember: true } : undefined;
  }
  const name = simpleName(fn);
  return name ? { name, viaMember: false } : undefined;
}

/** Java `method_invocation` → callee name. */
function javaCallee(call: Node): { name: string; viaMember: boolean } | undefined {
  const name = simpleName(call.childForFieldName('name'));
  if (!name) return undefined;
  return { name, viaMember: !!call.childForFieldName('object') };
}

const containerKindGeneric = (type: string): SymbolKind => {
  if (type.includes('interface')) return 'interface';
  if (type.includes('enum')) return 'enum';
  if (type.includes('trait')) return 'interface';
  // class, struct, record, impl, mod, etc. — all index as class for our purposes
  return 'class';
};

const GRAMMARS: Record<GrammarName, TypeSets> = {
  java: {
    containers: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'annotation_type_declaration',
    ]),
    methods: new Set(['method_declaration', 'constructor_declaration']),
    functions: new Set(),
    namespaces: new Set(),
    containerKind: containerKindGeneric,
    calls: { types: new Set(['method_invocation']), extract: javaCallee },
  },
  csharp: {
    containers: new Set([
      'class_declaration',
      'struct_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'record_struct_declaration',
    ]),
    methods: new Set(['method_declaration', 'constructor_declaration', 'destructor_declaration']),
    functions: new Set(),
    namespaces: new Set(['namespace_declaration', 'file_scoped_namespace_declaration']),
    containerKind: containerKindGeneric,
    calls: { types: new Set(['invocation_expression']), extract: csharpCallee },
  },
  python: {
    containers: new Set(['class_definition']),
    methods: new Set(),
    // Python doesn't distinguish in the grammar — function_definition inside
    // class_definition becomes a method via the parent-context branch in walk().
    functions: new Set(['function_definition']),
    namespaces: new Set(),
    containerKind: () => 'class',
  },
  go: {
    // type_spec is the inner declaration inside type_declaration. Using it as
    // the container directly gives us the name field one level up.
    containers: new Set(['type_spec']),
    methods: new Set(['method_declaration']),
    functions: new Set(['function_declaration']),
    namespaces: new Set(),
    containerKind: () => 'class',
  },
  rust: {
    containers: new Set([
      'struct_item',
      'enum_item',
      'trait_item',
      'union_item',
      'impl_item',
      'mod_item',
    ]),
    methods: new Set(),
    functions: new Set(['function_item']),
    namespaces: new Set(),
    containerKind: (type) => {
      if (type === 'trait_item') return 'interface';
      if (type === 'enum_item') return 'enum';
      if (type === 'mod_item') return 'namespace';
      return 'class';
    },
  },
  ruby: {
    containers: new Set(['class', 'module', 'singleton_class']),
    methods: new Set(['method', 'singleton_method']),
    functions: new Set(),
    namespaces: new Set(),
    containerKind: (type) => (type === 'module' ? 'namespace' : 'class'),
  },
  php: {
    containers: new Set([
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ]),
    methods: new Set(['method_declaration']),
    functions: new Set(['function_definition']),
    namespaces: new Set(['namespace_definition']),
    containerKind: containerKindGeneric,
  },
};

function chunkTypeForKind(kind: SymbolKind): CodeChunk['chunk_type'] {
  if (kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'type')
    return 'class';
  if (kind === 'namespace') return 'namespace';
  if (kind === 'method') return 'method';
  return 'function';
}

// --- node helpers ----------------------------------------------------------

const NAME_NODE_TYPES = new Set([
  'identifier',
  'type_identifier',
  'constant', // Ruby class names
  'name', // PHP
  'scoped_identifier', // PHP namespace path
  'field_identifier', // Go method receivers
]);

function nodeName(node: Node): string | undefined {
  const named = node.childForFieldName('name');
  if (named) return named.text;
  for (const child of node.namedChildren) {
    if (child && NAME_NODE_TYPES.has(child.type)) return child.text;
  }
  return undefined;
}

function signatureOf(node: Node): string {
  // Brace languages: stop at the first '{'. Indent languages (Python/Ruby):
  // stop at the first newline. Whichever comes first wins.
  const text = node.text;
  const brace = text.indexOf('{');
  const newline = text.indexOf('\n');
  let cut = -1;
  if (brace > 0 && newline > 0) cut = Math.min(brace, newline);
  else if (brace > 0) cut = brace;
  else if (newline > 0) cut = newline;
  const head = cut > 0 ? text.slice(0, cut) : text;
  return head.replace(/\s+/g, ' ').trim();
}

function isExportedJavaLike(node: Node, modifierType: 'modifiers' | 'modifier'): boolean {
  if (modifierType === 'modifiers') {
    const m = node.childForFieldName('modifiers');
    if (!m) return false;
    return /\bpublic\b/.test(m.text);
  }
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'modifier' || child.type === 'modifiers') {
      if (/\bpublic\b/.test(child.text)) return true;
    }
  }
  return false;
}

function exportedCheck(grammar: GrammarName, node: Node): boolean {
  switch (grammar) {
    case 'java':
      return isExportedJavaLike(node, 'modifiers');
    case 'csharp':
      return isExportedJavaLike(node, 'modifier');
    case 'rust': {
      // Rust uses `pub` (with optional parens).
      const first = node.children[0];
      if (!first) return false;
      return /\bpub\b/.test(first.text);
    }
    case 'go':
      // Go exports anything starting with an uppercase letter.
      return /^[A-Z]/.test(nodeName(node) ?? '');
    case 'python':
    case 'ruby':
      // Both consider top-level names visible unless they start with '_'.
      return !(nodeName(node) ?? '').startsWith('_');
    case 'php':
      // public is the default for PHP top-level declarations.
      return true;
  }
}

// --- walker ---------------------------------------------------------------

interface WalkCtx {
  grammar: GrammarName;
  ragolithLanguage: RagolithLanguage;
  types: TypeSets;
  opts: TreeSitterChunkOptions;
  out: ChunkResult;
}

function walkChildren(node: Node, parent: string | undefined, ctx: WalkCtx): void {
  // Statement-form namespaces (PHP `namespace Foo;` and C# file-scoped) affect
  // every subsequent sibling. Track the current namespace context as we walk.
  let currentParent = parent;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (ctx.types.namespaces.has(child.type)) {
      const name = nodeName(child);
      if (!name) {
        walk(child, currentParent, ctx);
        continue;
      }
      const fullName = currentParent ? `${currentParent}.${name}` : name;
      ctx.out.symbols.push({
        name,
        kind: 'namespace',
        signature: signatureOf(child),
        ...(currentParent ? { parent: currentParent } : {}),
        exports: true,
        file_path: ctx.opts.filePath,
        project: ctx.opts.project,
        start_line: child.startPosition.row + 1,
        end_line: child.endPosition.row + 1,
        language: ctx.ragolithLanguage,
      });
      // Two shapes to cover:
      //   - Block-form (C# `namespace X { ... }`, C# file-scoped: declarations
      //     are children of the namespace node) — walk its children with the
      //     namespace as parent.
      //   - Statement-form (PHP `namespace X;`): subsequent siblings inherit
      //     the namespace context.
      // Doing both is safe — walking children of a PHP statement-form
      // namespace just visits the `namespace_name` identifier (no-op), and
      // C# file-scoped has no siblings after it so shifting currentParent
      // has no observable effect.
      walkChildren(child, fullName, ctx);
      currentParent = fullName;
      continue;
    }
    walk(child, currentParent, ctx);
  }
}

function emitContainer(node: Node, parent: string | undefined, ctx: WalkCtx): void {
  const { types, opts, out } = ctx;
  const name = nodeName(node);
  if (!name) {
    walkChildren(node, parent, ctx);
    return;
  }
  const fullName = parent ? `${parent}.${name}` : name;
  const kind = types.containerKind(node.type);

  const symbol: SymbolRecord = {
    name,
    kind,
    signature: signatureOf(node),
    ...(parent ? { parent } : {}),
    exports: exportedCheck(ctx.grammar, node),
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

  // Descend into the body. Most grammars expose it as field `body`; some
  // (Go type_spec) embed the body as a sibling node type. Fall through to
  // walking all named children if no field is named.
  const body = node.childForFieldName('body');
  if (body) walkChildren(body, fullName, ctx);
  else walkChildren(node, fullName, ctx);
}

function emitMethodLike(
  node: Node,
  parent: string | undefined,
  ctx: WalkCtx,
  kind: SymbolKind,
): void {
  const { opts, out } = ctx;
  const name = nodeName(node);
  if (!name) {
    walkChildren(node, parent, ctx);
    return;
  }
  const fullName = parent ? `${parent}.${name}` : name;
  out.symbols.push({
    name,
    kind,
    signature: signatureOf(node),
    ...(parent ? { parent } : {}),
    exports: exportedCheck(ctx.grammar, node),
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
    chunk_type: chunkTypeForKind(kind),
    symbol: fullName,
  });

  collectCalls(node, fullName, ctx);
}

/**
 * Walk a method/function subtree and emit a CallEdge for every call/invocation
 * found, attributed to the enclosing symbol. No-op for grammars without a
 * `calls` spec. Nested calls inside arguments are captured (DFS over children).
 */
function collectCalls(root: Node, caller: string, ctx: WalkCtx): void {
  const spec = ctx.types.calls;
  if (!spec) return;
  const { opts, out } = ctx;
  const stack: Node[] = [...root.namedChildren.filter((c): c is Node => !!c)];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (spec.types.has(n.type)) {
      const callee = spec.extract(n);
      if (callee && callee.name) {
        out.edges.push({
          caller,
          callee: callee.name,
          call_type: callee.viaMember ? 'method' : 'static',
          file: opts.filePath,
          line: n.startPosition.row + 1,
          project: opts.project,
        });
      }
    }
    for (const ch of n.namedChildren) if (ch) stack.push(ch);
  }
}

function walk(node: Node, parent: string | undefined, ctx: WalkCtx): void {
  const { types } = ctx;

  // Namespaces are handled in walkChildren so siblings (statement-form
  // PHP `namespace Foo;` and C# file-scoped) get the right context. If a
  // namespace node reaches walk() directly (e.g. nested inside a container),
  // fall through to its children — losing the namespace context is harmless
  // here because containers are responsible for their own qualified paths.
  if (types.namespaces.has(node.type)) {
    walkChildren(node, parent, ctx);
    return;
  }

  if (types.containers.has(node.type)) {
    emitContainer(node, parent, ctx);
    return;
  }

  if (types.methods.has(node.type)) {
    emitMethodLike(node, parent, ctx, 'method');
    return;
  }

  if (types.functions.has(node.type)) {
    // Inside a container → method. Otherwise → function.
    emitMethodLike(node, parent, ctx, parent ? 'method' : 'function');
    return;
  }

  walkChildren(node, parent, ctx);
}

// --- public entry ----------------------------------------------------------

export interface TreeSitterChunkOptions {
  filePath: string;
  project: string;
  language: RagolithLanguage;
}

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
  const ctx: WalkCtx = {
    grammar,
    ragolithLanguage: opts.language,
    types: GRAMMARS[grammar],
    opts,
    out: result,
  };
  walkChildren(tree.rootNode, undefined, ctx);
  tree.delete();
  return result;
}

/**
 * High-level convenience used by the chunker dispatch: tree-sitter primary,
 * line-based fallback if it parses to nothing or throws.
 */
export async function chunkLanguageWithFallback(
  content: string,
  opts: TreeSitterChunkOptions,
  grammar: GrammarName,
): Promise<ChunkResult> {
  try {
    const result = await chunkWithTreeSitter(content, opts, grammar);
    if (result.chunks.length > 0) return result;
  } catch {
    // WASM load or runtime failure — fall through.
  }
  return chunkFallback(content, opts);
}
