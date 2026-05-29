// RSIF — Ragolith SDLC Interchange Format.
//
// A tool-agnostic, portable representation of SDLC artifacts (requirements,
// decisions, tickets, tests, runbooks, …). ragolith core NEVER talks to
// Jira/Confluence/Linear/GitHub APIs directly — instead, any tool exports to
// RSIF and ragolith indexes that. The format IS the integration contract;
// thin adapters (out of core) convert vendor exports into it.
//
// Two physical encodings, both decoding to the same `SdlcArtifact`:
//
//   1. NDJSON  (.ndjson / .jsonl) — one artifact JSON object per line. The
//      lossless, machine-friendly path. Bulk exports land here.
//
//   2. Markdown + YAML frontmatter (.md / .markdown) — one artifact per file,
//      human- and git-friendly. The body is prose; frontmatter is metadata:
//
//          ---
//          id: PROJ-123
//          kind: requirement
//          title: Users can reset their password
//          status: done
//          tags: [auth, security]
//          links:
//            - rel: implemented_by
//              target: repo:webapp/src/auth/reset.ts
//            - rel: tested_by
//              target: TC-45
//          ---
//          As a user I want to reset my password so that ...
//
// The frontmatter parser supports a documented YAML subset (scalars, flow and
// block sequences of scalars, and a block sequence of flat maps for `links`).
// Anything more exotic should use the NDJSON encoding, which has no parser of
// our own (plain JSON.parse per line).

import type { ArtifactLink, ArtifactLinkRel, SdlcArtifact, SdlcArtifactKind } from './types.js';

// --- vocabulary -------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set<SdlcArtifactKind>([
  'requirement',
  'story',
  'epic',
  'feature',
  'decision',
  'ticket',
  'risk',
  'test_case',
  'runbook',
  'api_spec',
  'design_doc',
  'meeting_note',
  'incident',
  'other',
]);

const LINK_RELS: ReadonlySet<string> = new Set<ArtifactLinkRel>([
  'implements',
  'implemented_by',
  'tests',
  'tested_by',
  'depends_on',
  'blocks',
  'blocked_by',
  'relates_to',
  'supersedes',
  'superseded_by',
  'derived_from',
  'refines',
  'mitigates',
  'parent_of',
  'child_of',
]);

/** Common aliases people use for `kind`, folded to the canonical vocabulary. */
const KIND_ALIASES: Record<string, SdlcArtifactKind> = {
  req: 'requirement',
  requirements: 'requirement',
  userstory: 'story',
  user_story: 'story',
  adr: 'decision',
  architecturedecision: 'decision',
  architecture_decision: 'decision',
  bug: 'ticket',
  task: 'ticket',
  issue: 'ticket',
  test: 'test_case',
  testcase: 'test_case',
  spec: 'api_spec',
  openapi: 'api_spec',
  swagger: 'api_spec',
  design: 'design_doc',
  doc: 'design_doc',
  notes: 'meeting_note',
  meeting: 'meeting_note',
  postmortem: 'incident',
  outage: 'incident',
};

export function coerceKind(raw: unknown): SdlcArtifactKind {
  if (typeof raw !== 'string') return 'other';
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (KINDS.has(k)) return k as SdlcArtifactKind;
  if (k in KIND_ALIASES) return KIND_ALIASES[k] as SdlcArtifactKind;
  // strip the _ we just added, try alias map without separators too
  const compact = k.replace(/_/g, '');
  if (compact in KIND_ALIASES) return KIND_ALIASES[compact] as SdlcArtifactKind;
  return 'other';
}

function coerceLinkRel(raw: unknown): ArtifactLinkRel | undefined {
  if (typeof raw !== 'string') return undefined;
  const r = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return LINK_RELS.has(r) ? (r as ArtifactLinkRel) : undefined;
}

// --- normalization ----------------------------------------------------------

export interface ArtifactDefaults {
  /** Fallback `source` label when an artifact doesn't declare one. */
  source: string;
  /** Fallback `project` when an artifact doesn't declare one. */
  project: string;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => asString(x)).filter((x): x is string => !!x && x.length > 0);
  }
  const s = asString(v);
  // Allow a comma-separated scalar for tags ("auth, security").
  if (s && s.includes(',')) {
    return s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return s ? [s] : [];
}

function normalizeLinks(v: unknown): ArtifactLink[] {
  if (!Array.isArray(v)) return [];
  const out: ArtifactLink[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rel = coerceLinkRel(rec['rel'] ?? rec['type'] ?? rec['relation']);
    const target = asString(rec['target'] ?? rec['to'] ?? rec['ref'] ?? rec['id']);
    if (rel && target) out.push({ rel, target });
  }
  return out;
}

/**
 * Build a validated SdlcArtifact from a loose record (frontmatter data or a
 * parsed NDJSON object), applying field aliases and defaults. Returns the
 * artifact plus a list of non-fatal warnings, or an error string if a required
 * field (artifact_id, title) is missing.
 */
export function normalizeArtifact(
  raw: Record<string, unknown>,
  defaults: ArtifactDefaults,
): { artifact: SdlcArtifact } | { error: string } {
  const artifactId = asString(raw['artifact_id'] ?? raw['id'] ?? raw['key'])?.trim();
  if (!artifactId) return { error: 'missing required field "artifact_id" (or "id")' };

  const title = asString(raw['title'] ?? raw['summary'] ?? raw['name'])?.trim();
  if (!title) return { error: `artifact "${artifactId}" missing required field "title"` };

  const body = asString(raw['body'] ?? raw['description'] ?? raw['content'] ?? raw['text']) ?? '';

  const artifact: SdlcArtifact = {
    artifact_id: artifactId,
    kind: coerceKind(raw['kind'] ?? raw['type']),
    title,
    body,
    source: asString(raw['source'])?.trim() || defaults.source,
    project: asString(raw['project'] ?? raw['product'])?.trim() || defaults.project,
    links: normalizeLinks(raw['links']),
    tags: asStringArray(raw['tags'] ?? raw['labels']),
  };

  const status = asString(raw['status'] ?? raw['state'])?.trim();
  if (status) artifact.status = status;
  const author = asString(raw['author'] ?? raw['reporter'] ?? raw['owner'])?.trim();
  if (author) artifact.author = author;
  const url = asString(raw['url'] ?? raw['link'] ?? raw['permalink'])?.trim();
  if (url) artifact.url = url;
  const createdAt = asString(raw['created_at'] ?? raw['created'])?.trim();
  if (createdAt) artifact.created_at = createdAt;
  const updatedAt = asString(raw['updated_at'] ?? raw['updated'] ?? raw['modified'])?.trim();
  if (updatedAt) artifact.updated_at = updatedAt;

  return { artifact };
}

// --- frontmatter (YAML subset) ----------------------------------------------

/**
 * Split a Markdown document into its frontmatter block and body. Frontmatter
 * is a leading `---` … `---` fence. Returns `data: undefined` when there's no
 * fence (the whole text is the body).
 */
export function splitFrontmatter(text: string): { raw: string | undefined; body: string } {
  // Normalize CRLF so the fence regex is simple.
  const norm = text.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) return { raw: undefined, body: text };
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return { raw: undefined, body: text };
  const raw = norm.slice(4, end);
  // Body starts after the closing fence line.
  let rest = norm.slice(end + 4);
  if (rest.startsWith('\n')) rest = rest.slice(1);
  return { raw, body: rest };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse a scalar value: quoted string, number, boolean, or bare string. */
function parseScalar(s: string): string | number | boolean {
  const t = s.trim();
  if (t === '') return '';
  if ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) {
    return stripQuotes(t);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Parse a flow sequence like `[a, b, "c d"]`. */
function parseFlowSeq(s: string): (string | number | boolean)[] {
  const inner = s.trim().slice(1, -1).trim();
  if (inner === '') return [];
  // Split on commas not inside quotes.
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => parseScalar(p));
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

/**
 * Parse the documented YAML subset used in RSIF frontmatter. Returns a plain
 * record. Unsupported constructs are skipped rather than throwing — the goal
 * is to extract what we recognize, not to be a conformant YAML engine.
 *
 * Supported:
 *   key: scalar
 *   key: [a, b, c]
 *   key:
 *     - scalar
 *     - scalar
 *   key:
 *     - rel: x
 *       target: y
 */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    // Skip blanks and comments.
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    // Only top-level (indent 0) keys start an entry.
    if (indentOf(line) !== 0) {
      i++;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const after = line.slice(colon + 1).trim();

    if (after !== '') {
      // Inline value.
      if (after.startsWith('[') && after.endsWith(']')) {
        out[key] = parseFlowSeq(after);
      } else {
        out[key] = parseScalar(after);
      }
      i++;
      continue;
    }

    // Block value — look ahead at indented lines.
    const blockLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] ?? '';
      if (l.trim() === '') {
        blockLines.push(l);
        j++;
        continue;
      }
      if (indentOf(l) === 0) break;
      blockLines.push(l);
      j++;
    }
    out[key] = parseBlock(blockLines);
    i = j;
  }

  return out;
}

/** Parse an indented block: either a sequence (`- …`) or ignored. */
function parseBlock(blockLines: string[]): unknown {
  const nonEmpty = blockLines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return '';

  // A new item starts at each `- ` at the shallowest indent; deeper
  // `key: value` lines attach to the current item. It's a sequence iff the
  // lines AT that shallowest indent all begin with `- ` (continuation lines
  // are deeper and need not).
  const itemIndent = Math.min(...nonEmpty.map((l) => indentOf(l)));
  const itemLines = nonEmpty.filter((l) => indentOf(l) === itemIndent);
  const isSeq = itemLines.length > 0 && itemLines.every((l) => l.trim().startsWith('- '));
  if (!isSeq) {
    // Not a construct we model — return the joined text so a `body`-ish field
    // at least keeps its content.
    return nonEmpty.map((l) => l.trim()).join('\n');
  }
  const items: unknown[] = [];
  let current: Record<string, unknown> | null = null;
  let currentScalar: (string | number | boolean) | null = null;

  const flush = (): void => {
    if (current !== null) items.push(current);
    else if (currentScalar !== null) items.push(currentScalar);
    current = null;
    currentScalar = null;
  };

  for (const l of nonEmpty) {
    const ind = indentOf(l);
    const t = l.trim();
    if (ind === itemIndent && t.startsWith('- ')) {
      flush();
      const rest = t.slice(2).trim();
      const colon = rest.indexOf(':');
      if (colon !== -1 && !rest.startsWith('"') && !rest.startsWith("'")) {
        // `- key: value` → start a map item.
        current = {};
        const k = rest.slice(0, colon).trim();
        current[k] = parseScalar(rest.slice(colon + 1));
      } else {
        // `- scalar` → scalar item.
        currentScalar = parseScalar(rest);
      }
    } else if (current !== null) {
      // Continuation line of a map item: `  key: value`.
      const colon = t.indexOf(':');
      if (colon !== -1) {
        const k = t.slice(0, colon).trim();
        current[k] = parseScalar(t.slice(colon + 1));
      }
    }
  }
  flush();
  return items;
}

// --- top-level parse entry points -------------------------------------------

export interface ParseResult {
  artifacts: SdlcArtifact[];
  /** Non-fatal problems (a bad NDJSON line, a doc missing a title, …). */
  warnings: string[];
}

/** Parse a single Markdown+frontmatter document into one artifact. */
export function parseMarkdownArtifact(
  text: string,
  defaults: ArtifactDefaults,
  opts: { fallbackId?: string; fallbackTitle?: string } = {},
): ParseResult {
  const { raw, body } = splitFrontmatter(text);
  const data: Record<string, unknown> = raw ? parseFrontmatter(raw) : {};

  // The markdown body wins over any `body:` key in frontmatter (which is rare).
  if (body.trim() !== '') data['body'] = body;

  // Fall back to a filename-derived id / first-heading title when absent.
  if (data['artifact_id'] === undefined && data['id'] === undefined && opts.fallbackId) {
    data['artifact_id'] = opts.fallbackId;
  }
  if (data['title'] === undefined && data['summary'] === undefined && data['name'] === undefined) {
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) data['title'] = heading;
    else if (opts.fallbackTitle) data['title'] = opts.fallbackTitle;
  }

  const res = normalizeArtifact(data, defaults);
  if ('error' in res) return { artifacts: [], warnings: [res.error] };
  return { artifacts: [res.artifact], warnings: [] };
}

/** Parse an NDJSON / JSONL blob into artifacts. One object per non-blank line. */
export function parseNdjson(text: string, defaults: ArtifactDefaults): ParseResult {
  const artifacts: SdlcArtifact[] = [];
  const warnings: string[] = [];
  const lines = text.split('\n');
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const t = line.trim();
    if (t === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      warnings.push(`line ${lineNo}: not valid JSON, skipped`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`line ${lineNo}: not a JSON object, skipped`);
      continue;
    }
    const res = normalizeArtifact(parsed as Record<string, unknown>, defaults);
    if ('error' in res) warnings.push(`line ${lineNo}: ${res.error}`);
    else artifacts.push(res.artifact);
  }
  return { artifacts, warnings };
}

/**
 * Parse a JSON array file (`.json`) of artifacts — convenient when a tool
 * exports a single array rather than NDJSON.
 */
export function parseJsonArray(text: string, defaults: ArtifactDefaults): ParseResult {
  const artifacts: SdlcArtifact[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { artifacts: [], warnings: [`not valid JSON: ${String(err)}`] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  arr.forEach((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`item ${idx}: not a JSON object, skipped`);
      return;
    }
    const res = normalizeArtifact(item as Record<string, unknown>, defaults);
    if ('error' in res) warnings.push(`item ${idx}: ${res.error}`);
    else artifacts.push(res.artifact);
  });
  return { artifacts, warnings };
}

const MD_EXTS = new Set(['.md', '.markdown']);
const NDJSON_EXTS = new Set(['.ndjson', '.jsonl']);

/** Is this filename one ragolith recognizes as an RSIF encoding? */
export function isRsifFile(filename: string): boolean {
  const ext = extLower(filename);
  return MD_EXTS.has(ext) || NDJSON_EXTS.has(ext) || ext === '.json';
}

function extLower(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

function baseName(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const name = slash === -1 ? filename : filename.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * Parse any recognized RSIF file by dispatching on its extension. `filename`
 * is used both to pick the decoder and to derive a fallback id/title for
 * bare Markdown files without frontmatter.
 */
export function parseRsifFile(
  filename: string,
  text: string,
  defaults: ArtifactDefaults,
): ParseResult {
  const ext = extLower(filename);
  if (NDJSON_EXTS.has(ext)) return parseNdjson(text, defaults);
  if (ext === '.json') return parseJsonArray(text, defaults);
  if (MD_EXTS.has(ext)) {
    const base = baseName(filename);
    return parseMarkdownArtifact(text, defaults, {
      fallbackId: base,
      fallbackTitle: base,
    });
  }
  return { artifacts: [], warnings: [`${filename}: unrecognized RSIF extension`] };
}

/**
 * Build the embedded `content` string for an artifact: a small context prefix
 * plus title and body, mirroring how code chunks get a project prefix. This is
 * what the SdlcArtifact collection vectorizes.
 */
export function artifactContent(a: SdlcArtifact): string {
  const prefix = `[${a.kind}] [project:${a.project}] [id:${a.artifact_id}]`;
  return `${prefix} ${a.title}\n\n${a.body}`.trim();
}
