#!/usr/bin/env node
// MCP server — exposes ragolith's index as 23 tools over stdio JSON-RPC.
//
// Designed to be spawned as a child process by an MCP-aware LLM client
// (Claude Desktop, Cursor, etc.). Reads config the same way the CLIs do.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Filters, type WeaviateClient } from 'weaviate-client';
import { loadConfig } from '../core/config.js';
import {
  connect,
  ensureSchema,
  fetchCallEdges,
  fetchDecompositionInputs,
  getArtifact,
  getTechStack,
  listArtifacts,
  listProjectStacks,
  CODE_CHUNK,
  SYMBOL_RECORD,
  CALL_EDGE,
} from '../core/weaviate-client.js';
import { search, searchArtifacts } from '../core/search.js';
import { analyzeGaps } from '../core/analysis/gaps.js';
import { analyzeModernization } from '../core/analysis/modernization.js';
import { decomposeProject } from '../core/analysis/decomposition.js';
import { traceFlow } from '../core/analysis/callgraph.js';
import { buildProjectStructure } from '../core/structure.js';
import { matchesWildcard, toPathPattern } from '../core/glob.js';
import type { IngestState, Language, SdlcArtifactKind, SearchHit } from '../core/types.js';

const cfg = loadConfig();

// Shared search knobs from the active effort profile in config. Tuning the
// profile in the dashboard (or editing ragc.config.json) changes how much the
// LLM client ingests per query — maxContentChars is the main token lever.
const SEARCH_KNOBS = {
  overFetch: cfg.search.overFetch,
  diversityPerFile: cfg.search.diversityPerFile,
  rerankerEnabled: cfg.search.rerankerEnabled,
  ...(cfg.search.maxContentChars ? { maxContentChars: cfg.search.maxContentChars } : {}),
};
const DEFAULT_LIMIT = cfg.search.limit ?? 10;

function jsonResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function loadState(): IngestState {
  const path = resolve(cfg.ingest.stateFile);
  if (!existsSync(path)) return { projects: {}, files: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as IngestState;
}

async function makeServer(client: WeaviateClient): Promise<McpServer> {
  const server = new McpServer({ name: 'ragolith', version: '0.1.0' });

  const searchOptsSchema = {
    query: z.string().describe('Free-text query — natural language or identifier'),
    limit: z.number().int().min(1).max(50).optional().describe('Max hits to return (default 10)'),
    project: z.string().optional().describe('Restrict to a single project name'),
    language: z.string().optional().describe('Restrict to one language (typescript, java, …)'),
  };

  // 1. search — main hybrid search.
  server.tool(
    'search',
    'Hybrid semantic + keyword search across all indexed code and documents. Returns top hits with file path, line range, and content.',
    searchOptsSchema,
    async ({ query, limit, project, language }) => {
      const hits = await search(client, {
        query,
        limit: limit ?? DEFAULT_LIMIT,
        ...(project ? { project } : {}),
        ...(language ? { language: language as Language } : {}),
        ...SEARCH_KNOBS,
      });
      return jsonResult(hits);
    },
  );

  // 2. search_code — restricted to code languages.
  server.tool(
    'search_code',
    'Search restricted to code chunks (excludes PDF, DOCX, Markdown).',
    searchOptsSchema,
    async ({ query, limit, project }) => {
      const want = limit ?? DEFAULT_LIMIT;
      const hits = await search(client, {
        query,
        limit: want * 2,
        ...(project ? { project } : {}),
        ...SEARCH_KNOBS,
      });
      const docLangs = new Set<Language>(['pdf', 'docx', 'markdown']);
      const filtered = hits.filter((h) => !docLangs.has(h.language)).slice(0, want);
      return jsonResult(filtered);
    },
  );

  // 3. search_docs — restricted to documentation.
  server.tool(
    'search_docs',
    'Search restricted to documentation (Markdown, PDF, DOCX).',
    searchOptsSchema,
    async ({ query, limit, project }) => {
      const want = limit ?? DEFAULT_LIMIT;
      const hits = await search(client, {
        query,
        limit: want * 2,
        ...(project ? { project } : {}),
        ...SEARCH_KNOBS,
      });
      const docLangs = new Set<Language>(['pdf', 'docx', 'markdown']);
      const filtered = hits.filter((h) => docLangs.has(h.language)).slice(0, want);
      return jsonResult(filtered);
    },
  );

  // 4. find_symbol — exact / prefix symbol lookup.
  server.tool(
    'find_symbol',
    'Look up function / class / method declarations by name. Supports exact match and prefix; falls back to semantic code search (returning related symbols) when there is no exact/prefix match.',
    {
      name: z.string().describe('Symbol name to find (case-sensitive)'),
      prefix: z.boolean().optional().describe('Match by prefix instead of exact (default false)'),
      project: z.string().optional(),
      kind: z
        .enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'namespace'])
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ name, prefix, project, kind, limit }) => {
      const col = client.collections.get(SYMBOL_RECORD);
      const nameClause = prefix
        ? col.filter.byProperty('name').like(`${name}*`)
        : col.filter.byProperty('name').equal(name);
      const extra = [
        project ? col.filter.byProperty('project').equal(project) : undefined,
        kind ? col.filter.byProperty('kind').equal(kind) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const combined = extra.length === 0 ? nameClause : Filters.and(nameClause, ...extra);
      const res = await col.query.fetchObjects({ filters: combined, limit: limit ?? 50 });
      if (res.objects.length > 0) return jsonResult(res.objects.map((o) => o.properties));
      // Semantic fallback — no exact/prefix declaration on file. Search the
      // code index for the term and surface the symbols of the best hits, so a
      // fuzzy or misspelled name still leads somewhere.
      const hits = await search(client, {
        query: name,
        limit: limit ?? 10,
        ...(project ? { project } : {}),
        ...SEARCH_KNOBS,
      });
      const fallback = hits
        .filter((h) => h.symbol)
        .map((h) => ({
          name: h.symbol,
          file_path: h.file_path,
          project: h.project,
          start_line: h.start_line,
          end_line: h.end_line,
          language: h.language,
          kind: h.chunk_type,
          score: h.score,
          match: 'semantic' as const,
        }));
      return jsonResult(fallback);
    },
  );

  // 5. file_structure — list all symbols in a file.
  server.tool(
    'file_structure',
    'List all symbols (functions, classes, methods) declared in a single file.',
    {
      file_path: z.string().describe('Path relative to the repo root, as stored in the index'),
      project: z.string().optional(),
    },
    async ({ file_path, project }) => {
      const col = client.collections.get(SYMBOL_RECORD);
      const base = col.filter.byProperty('file_path').equal(file_path);
      const f = project ? Filters.and(base, col.filter.byProperty('project').equal(project)) : base;
      const res = await col.query.fetchObjects({ filters: f, limit: 1000 });
      const sorted = [...res.objects].sort((a, b) => {
        const al = Number((a.properties as Record<string, unknown>)['start_line'] ?? 0);
        const bl = Number((b.properties as Record<string, unknown>)['start_line'] ?? 0);
        return al - bl;
      });
      return jsonResult(sorted.map((o) => o.properties));
    },
  );

  // 6. read_chunk — fetch chunks at a file/line range.
  server.tool(
    'read_chunk',
    'Fetch indexed chunks intersecting a specific file path (and optional line range).',
    {
      file_path: z.string(),
      project: z.string().optional(),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
    },
    async ({ file_path, project, start_line, end_line }) => {
      const col = client.collections.get(CODE_CHUNK);
      const clauses = [
        col.filter.byProperty('file_path').equal(file_path),
        project ? col.filter.byProperty('project').equal(project) : undefined,
        typeof end_line === 'number'
          ? col.filter.byProperty('start_line').lessOrEqual(end_line)
          : undefined,
        typeof start_line === 'number'
          ? col.filter.byProperty('end_line').greaterOrEqual(start_line)
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      // clauses.length is checked above; index access is safe.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const f = clauses.length === 1 ? clauses[0]! : Filters.and(...clauses);
      const res = await col.query.fetchObjects({ filters: f, limit: 50 });
      const sorted = [...res.objects].sort((a, b) => {
        const al = Number((a.properties as Record<string, unknown>)['start_line'] ?? 0);
        const bl = Number((b.properties as Record<string, unknown>)['start_line'] ?? 0);
        return al - bl;
      });
      return jsonResult(
        sorted.map((o) => {
          const p = o.properties as Record<string, unknown>;
          return {
            file_path: p['file_path'],
            project: p['project'],
            start_line: p['start_line'],
            end_line: p['end_line'],
            language: p['language'],
            chunk_type: p['chunk_type'],
            symbol: p['symbol'],
            content: p['raw_content'] ?? p['content'],
          };
        }),
      );
    },
  );

  // 7. callers_of — call edges across all supported languages.
  server.tool(
    'callers_of',
    'Return all callers of a function/method name. Works across all supported languages (TS/JS, Java, C#, Python, Go, Rust, Ruby, PHP).',
    {
      callee: z.string().describe('Bare function or method name'),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ callee, project, limit }) => {
      const col = client.collections.get(CALL_EDGE);
      const base = col.filter.byProperty('callee').equal(callee);
      const f = project ? Filters.and(base, col.filter.byProperty('project').equal(project)) : base;
      const res = await col.query.fetchObjects({ filters: f, limit: limit ?? 100 });
      return jsonResult(res.objects.map((o) => o.properties));
    },
  );

  // 8. callees_of — call edges across all supported languages.
  server.tool(
    'callees_of',
    'Return all callees invoked from a function/method name. Works across all supported languages (TS/JS, Java, C#, Python, Go, Rust, Ruby, PHP).',
    {
      caller: z.string().describe('Caller as `Name` or `Class.method`'),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ caller, project, limit }) => {
      const col = client.collections.get(CALL_EDGE);
      const base = col.filter.byProperty('caller').equal(caller);
      const f = project ? Filters.and(base, col.filter.byProperty('project').equal(project)) : base;
      const res = await col.query.fetchObjects({ filters: f, limit: limit ?? 100 });
      return jsonResult(res.objects.map((o) => o.properties));
    },
  );

  // 9. list_projects — what's indexed and at which commit.
  server.tool(
    'list_projects',
    'List indexed projects with their last-ingested commit SHA and update time.',
    {},
    async () => {
      const state = loadState();
      const projects = Object.entries(state.projects).map(([name, v]) => ({
        name,
        commit_sha: v.commit_sha,
        updated_at: v.updated_at,
      }));
      return jsonResult({ projects, files: Object.keys(state.files) });
    },
  );

  // 10. tech_stack — detected frameworks / runtimes / build tools per project.
  server.tool(
    'tech_stack',
    'Return the detected tech stack for a project — frameworks (e.g. Spring Boot, React), runtime versions (Java, Node, Python), build tools, and the manifests they were derived from. Useful for grounding modernization or upgrade questions.',
    {
      project: z.string().describe('Project name as listed by list_projects'),
    },
    async ({ project }) => {
      const stack = await getTechStack(client, project);
      if (!stack) {
        return jsonResult({
          project,
          error: 'no tech stack on file — has this project been ingested?',
        });
      }
      return jsonResult(stack);
    },
  );

  // 11. list_files — distinct files indexed for a project (or all).
  server.tool(
    'list_files',
    'List distinct file paths indexed under a project (or across all projects).',
    {
      project: z.string().optional(),
      language: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    },
    async ({ project, language, limit }) => {
      const col = client.collections.get(CODE_CHUNK);
      const clauses = [
        project ? col.filter.byProperty('project').equal(project) : undefined,
        language ? col.filter.byProperty('language').equal(language) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const f =
        clauses.length === 0
          ? undefined
          : clauses.length === 1
            ? // clauses.length is checked above; index access is safe.
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              clauses[0]!
            : Filters.and(...clauses);
      const res = await col.query.fetchObjects({
        ...(f ? { filters: f } : {}),
        limit: limit ?? 2000,
        returnProperties: ['file_path', 'project', 'language'],
      });
      const seen = new Set<string>();
      const out: { project: string; file_path: string; language: string }[] = [];
      for (const o of res.objects) {
        const p = o.properties as Record<string, unknown>;
        const key = `${p['project']}::${p['file_path']}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          project: String(p['project'] ?? ''),
          file_path: String(p['file_path'] ?? ''),
          language: String(p['language'] ?? ''),
        });
      }
      return jsonResult(out);
    },
  );

  // 12. search_sdlc — hybrid search over SDLC artifacts.
  server.tool(
    'search_sdlc',
    'Search SDLC artifacts — requirements, design decisions (ADRs), tickets, test cases, runbooks, API specs, incidents. Returns title, kind, status, excerpt, and source. Use this for "what did we decide about X", "which requirements cover Y", "is there a runbook for Z".',
    {
      query: z.string().describe('Free-text query — natural language or identifier'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10)'),
      project: z.string().optional().describe('Restrict to one project/product'),
      source: z.string().optional().describe('Restrict to one source system (jira, local, …)'),
      kind: z
        .string()
        .optional()
        .describe('Restrict to one kind (requirement, decision, ticket, test_case, …)'),
    },
    async ({ query, limit, project, source, kind }) => {
      const hits = await searchArtifacts(client, {
        query,
        limit: limit ?? DEFAULT_LIMIT,
        ...(project ? { project } : {}),
        ...(source ? { source } : {}),
        ...(kind ? { kind: kind as SdlcArtifactKind } : {}),
        rerankerEnabled: cfg.search.rerankerEnabled,
        ...(cfg.search.maxContentChars ? { maxContentChars: cfg.search.maxContentChars } : {}),
      });
      return jsonResult(hits);
    },
  );

  // 13. list_artifacts — enumerate SDLC artifacts with metadata filters.
  server.tool(
    'list_artifacts',
    'List SDLC artifacts with optional filters (project, source, kind, status). Returns id, kind, title, status, and link count — a lightweight inventory, not full bodies. Use search_sdlc for content search.',
    {
      project: z.string().optional(),
      source: z.string().optional(),
      kind: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    },
    async ({ project, source, kind, status, limit }) => {
      const artifacts = await listArtifacts(client, {
        ...(project ? { project } : {}),
        ...(source ? { source } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
      });
      const summary = artifacts.map((a) => ({
        artifact_id: a.artifact_id,
        kind: a.kind,
        title: a.title,
        status: a.status ?? '',
        project: a.project,
        source: a.source,
        links: a.links.length,
      }));
      return jsonResult(summary);
    },
  );

  // 14. get_artifact — full artifact by (source, id).
  server.tool(
    'get_artifact',
    'Fetch one SDLC artifact in full — body, tags, links, status, url — by its source and artifact_id (as returned by search_sdlc / list_artifacts).',
    {
      source: z.string().describe('Source label, e.g. "jira" or the config source name'),
      artifact_id: z.string().describe('Artifact id, e.g. "PROJ-123" or "ADR-0007"'),
    },
    async ({ source, artifact_id }) => {
      const artifact = await getArtifact(client, source, artifact_id);
      if (!artifact) {
        return jsonResult({
          source,
          artifact_id,
          error: 'not found — check source + artifact_id, or whether it has been ingested',
        });
      }
      return jsonResult(artifact);
    },
  );

  // 15. analyze_gaps — traceability gaps over the SDLC artifact graph.
  server.tool(
    'analyze_gaps',
    'Find traceability gaps across the SDLC artifact graph: requirements with no implementation link, implementations with no test, accepted decisions never built, orphan tests, and links pointing to unknown artifacts. Returns a report with per-gap detail + severity and summary counts. Use for "what is unbuilt / untested / untraced".',
    {
      project: z.string().optional().describe('Restrict analysis to one project/product'),
    },
    async ({ project }) => {
      const artifacts = await listArtifacts(client, project ? { project } : {});
      return jsonResult(analyzeGaps(artifacts));
    },
  );

  // 16. analyze_modernization — EOL / legacy runtimes + frameworks.
  server.tool(
    'analyze_modernization',
    'Flag end-of-life or legacy runtimes (Java 8, Node 16, Python 2, …) and frameworks (Spring Boot 2.x, AngularJS, Vue 2, legacy javax.* Java EE, …) from a project\'s detected tech stack, each with an upgrade recommendation. Use for "what needs upgrading", "are we on anything end-of-life", modernization planning.',
    {
      project: z.string().optional().describe('Restrict to one project; omit to scan all'),
    },
    async ({ project }) => {
      const stacks = project
        ? await (async () => {
            const s = await getTechStack(client, project);
            return s ? [s] : [];
          })()
        : await listProjectStacks(client);
      return jsonResult(stacks.map((s) => analyzeModernization(s)));
    },
  );

  // 17. analyze_decomposition — suggest service boundaries for a monolith.
  server.tool(
    'analyze_decomposition',
    'Analyze a project\'s module dependency graph (from call edges) and suggest microservice boundaries: per-module cohesion + instability + fan-in/out, candidate "seams" (cohesive, loosely-coupled modules to extract first), and the tightest cross-module couplings (the hardest joints to cut). Use for monolith-to-microservices migration planning. Uses call edges, extracted across all supported languages (TS/JS, Java, C#, Python, Go, Rust, Ruby, PHP).',
    {
      project: z.string().describe('Project name as listed by list_projects'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe('Path segments that form a module key (default 1)'),
    },
    async ({ project, depth }) => {
      const inputs = await fetchDecompositionInputs(client, project);
      return jsonResult(decomposeProject(project, inputs, { moduleDepth: depth ?? 1 }));
    },
  );

  // 18. trace_flow — multi-hop call traversal (impact analysis).
  server.tool(
    'trace_flow',
    'Trace a function/method call chain several hops outward — downstream (callees), upstream (callers), or both. Returns the edges found at each hop plus every reachable symbol. Use for "what does X eventually call", "what breaks if I change Y", and cross-cutting impact analysis. Works across all supported languages.',
    {
      symbol: z.string().describe('Function/method to start from — bare name or `Class.method`'),
      direction: z
        .enum(['callees', 'callers', 'both'])
        .optional()
        .describe('callees = downstream, callers = upstream, both (default)'),
      max_hops: z.number().int().min(1).max(6).optional().describe('Traversal depth (default 3)'),
      project: z.string().optional(),
    },
    async ({ symbol, direction, max_hops, project }) => {
      const edges = await fetchCallEdges(client, project);
      const result = traceFlow(
        edges.map((e) => ({ caller: e.caller, callee: e.callee, file: e.file, line: e.line })),
        symbol,
        { direction: direction ?? 'both', maxHops: max_hops ?? 3 },
      );
      return jsonResult(result);
    },
  );

  // 19. compare_systems — same query against two projects, side by side.
  server.tool(
    'compare_systems',
    'Run one query against two projects and return both result sets side by side — for comparing how two systems implement the same concept (migrations, consolidating duplicate functionality, "does the new service cover what the old one did").',
    {
      query: z.string().describe('Free-text query to run against both projects'),
      project_a: z.string().describe('First project name'),
      project_b: z.string().describe('Second project name'),
      limit: z.number().int().min(1).max(50).optional().describe('Hits per project (default 10)'),
    },
    async ({ query, project_a, project_b, limit }) => {
      const want = limit ?? DEFAULT_LIMIT;
      const [a, b] = await Promise.all([
        search(client, { query, limit: want, project: project_a, ...SEARCH_KNOBS }),
        search(client, { query, limit: want, project: project_b, ...SEARCH_KNOBS }),
      ]);
      return jsonResult({
        query,
        a: { project: project_a, hits: a },
        b: { project: project_b, hits: b },
      });
    },
  );

  // 20. search_code_bulk — many queries, one merged/deduped result.
  server.tool(
    'search_code_bulk',
    'Run several searches in one call and get a merged, de-duplicated result set (dedup by project + file + line range, each hit tagged with the query that found it). Cheaper than many round-trips when you have a list of concepts to locate.',
    {
      queries: z.array(z.string()).min(1).max(20).describe('List of search queries'),
      project: z.string().optional(),
      limit_per_query: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Hits per query before dedup (default 5)'),
    },
    async ({ queries, project, limit_per_query }) => {
      const per = limit_per_query ?? 5;
      const results = await Promise.all(
        queries.map((q) =>
          search(client, {
            query: q,
            limit: per,
            ...(project ? { project } : {}),
            ...SEARCH_KNOBS,
          }),
        ),
      );
      const seen = new Set<string>();
      const hits: (SearchHit & { matched_query: string })[] = [];
      queries.forEach((q, i) => {
        for (const h of results[i] ?? []) {
          const key = `${h.project}::${h.file_path}:${h.start_line}-${h.end_line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ ...h, matched_query: q });
        }
      });
      return jsonResult({ queries, total: hits.length, hits });
    },
  );

  // 21. get_full_file — reconstruct a whole file from its chunks.
  server.tool(
    'get_full_file',
    'Reconstruct a whole indexed file by concatenating its chunks in line order. Returns the joined source plus chunk count and line span. Use when you need the entire file, not just search hits. (Reconstruction is approximate when chunks overlap or leave gaps.)',
    {
      file_path: z.string().describe('Path as stored in the index'),
      project: z.string().optional(),
    },
    async ({ file_path, project }) => {
      const col = client.collections.get(CODE_CHUNK);
      const base = col.filter.byProperty('file_path').equal(file_path);
      const f = project ? Filters.and(base, col.filter.byProperty('project').equal(project)) : base;
      const res = await col.query.fetchObjects({ filters: f, limit: 1000 });
      const ordered = [...res.objects]
        .map((o) => o.properties as Record<string, unknown>)
        .sort((a, b) => Number(a['start_line'] ?? 0) - Number(b['start_line'] ?? 0));
      if (ordered.length === 0) {
        return jsonResult({
          file_path,
          project: project ?? null,
          error: 'no chunks indexed for this file',
        });
      }
      const seen = new Set<string>();
      const distinct = ordered.filter((c) => {
        const key = `${c['start_line']}-${c['end_line']}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const content = distinct
        .map((c) => String(c['raw_content'] ?? c['content'] ?? ''))
        .join('\n');
      const last = distinct[distinct.length - 1];
      return jsonResult({
        file_path,
        project: distinct[0]?.['project'] ?? project ?? null,
        language: distinct[0]?.['language'] ?? null,
        chunks: distinct.length,
        start_line: distinct[0]?.['start_line'] ?? null,
        end_line: last?.['end_line'] ?? null,
        content,
      });
    },
  );

  // 22. search_code_by_file — search scoped to a path glob.
  server.tool(
    'search_code_by_file',
    'Search within files whose path matches a glob/substring — e.g. scope a query to "src/auth" or "*.controller.ts". Omit the query to just list the chunks in those files in line order.',
    {
      path: z.string().describe('File path, prefix, or wildcard (`*`, `?`) to scope to'),
      query: z.string().optional().describe('Optional query; omit to list chunks in the path'),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ path, query, project, limit }) => {
      const col = client.collections.get(CODE_CHUNK);
      const pattern = toPathPattern(path);
      if (!query) {
        const clauses = [
          col.filter.byProperty('file_path').like(pattern),
          project ? col.filter.byProperty('project').equal(project) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const f = clauses.length === 1 ? clauses[0]! : Filters.and(...clauses);
        const res = await col.query.fetchObjects({ filters: f, limit: limit ?? 50 });
        const rows = [...res.objects]
          .map((o) => o.properties as Record<string, unknown>)
          .sort(
            (a, b) =>
              String(a['file_path']).localeCompare(String(b['file_path'])) ||
              Number(a['start_line'] ?? 0) - Number(b['start_line'] ?? 0),
          )
          .map((p) => ({
            file_path: p['file_path'],
            project: p['project'],
            start_line: p['start_line'],
            end_line: p['end_line'],
            language: p['language'],
            chunk_type: p['chunk_type'],
            symbol: p['symbol'],
            content: p['raw_content'] ?? p['content'],
          }));
        return jsonResult(rows);
      }
      // With a query: run the full search pipeline, then keep only path matches.
      const want = limit ?? DEFAULT_LIMIT;
      const hits = await search(client, {
        query,
        limit: want * 4,
        ...(project ? { project } : {}),
        ...SEARCH_KNOBS,
      });
      const filtered = hits.filter((h) => matchesWildcard(pattern, h.file_path)).slice(0, want);
      return jsonResult(filtered);
    },
  );

  // 23. get_project_structure — directory-grouped file tree.
  server.tool(
    'get_project_structure',
    'Return the indexed file tree for a project, grouped by directory with per-directory and per-language file counts. A fast orientation map of what exists, without reading any file contents.',
    {
      project: z.string().optional(),
      language: z.string().optional(),
    },
    async ({ project, language }) => {
      const col = client.collections.get(CODE_CHUNK);
      const clauses = [
        project ? col.filter.byProperty('project').equal(project) : undefined,
        language ? col.filter.byProperty('language').equal(language) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const f =
        clauses.length === 0
          ? undefined
          : clauses.length === 1
            ? // clauses.length is checked above; index access is safe.
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              clauses[0]!
            : Filters.and(...clauses);
      const res = await col.query.fetchObjects({
        ...(f ? { filters: f } : {}),
        limit: 10000,
        returnProperties: ['file_path', 'project', 'language'],
      });
      const files = res.objects.map((o) => {
        const p = o.properties as Record<string, unknown>;
        return {
          file_path: String(p['file_path'] ?? ''),
          project: String(p['project'] ?? ''),
          language: String(p['language'] ?? ''),
        };
      });
      return jsonResult(buildProjectStructure(files));
    },
  );

  return server;
}

async function main(): Promise<void> {
  const client = await connect(cfg.weaviate);
  await ensureSchema(client, { reranker: cfg.search.rerankerEnabled });
  const server = await makeServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive — the transport keeps stdio open until the parent process exits.
}

main().catch((err) => {
  // MCP clients read stdout for JSON-RPC; route errors to stderr.
  process.stderr.write(
    `[ragolith-server] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
