#!/usr/bin/env node
// MCP server — exposes ragolith's index as 14 tools over stdio JSON-RPC.
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
  getArtifact,
  getTechStack,
  listArtifacts,
  CODE_CHUNK,
  SYMBOL_RECORD,
  CALL_EDGE,
} from '../core/weaviate-client.js';
import { search, searchArtifacts } from '../core/search.js';
import type { IngestState, Language, SdlcArtifactKind } from '../core/types.js';

const cfg = loadConfig();

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
        limit: limit ?? 10,
        ...(project ? { project } : {}),
        ...(language ? { language: language as Language } : {}),
        overFetch: cfg.search.overFetch,
        diversityPerFile: cfg.search.diversityPerFile,
        rerankerEnabled: cfg.search.rerankerEnabled,
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
      const hits = await search(client, {
        query,
        limit: (limit ?? 10) * 2,
        ...(project ? { project } : {}),
        overFetch: cfg.search.overFetch,
        diversityPerFile: cfg.search.diversityPerFile,
        rerankerEnabled: cfg.search.rerankerEnabled,
      });
      const docLangs = new Set<Language>(['pdf', 'docx', 'markdown']);
      const filtered = hits.filter((h) => !docLangs.has(h.language)).slice(0, limit ?? 10);
      return jsonResult(filtered);
    },
  );

  // 3. search_docs — restricted to documentation.
  server.tool(
    'search_docs',
    'Search restricted to documentation (Markdown, PDF, DOCX).',
    searchOptsSchema,
    async ({ query, limit, project }) => {
      const hits = await search(client, {
        query,
        limit: (limit ?? 10) * 2,
        ...(project ? { project } : {}),
        overFetch: cfg.search.overFetch,
        diversityPerFile: cfg.search.diversityPerFile,
        rerankerEnabled: cfg.search.rerankerEnabled,
      });
      const docLangs = new Set<Language>(['pdf', 'docx', 'markdown']);
      const filtered = hits.filter((h) => docLangs.has(h.language)).slice(0, limit ?? 10);
      return jsonResult(filtered);
    },
  );

  // 4. find_symbol — exact / prefix symbol lookup.
  server.tool(
    'find_symbol',
    'Look up function / class / method declarations by name. Supports exact match and prefix.',
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
      return jsonResult(res.objects.map((o) => o.properties));
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

  // 7. callers_of — TS/JS only.
  server.tool(
    'callers_of',
    'Return all callers of a function/method name (TS/JS only).',
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

  // 8. callees_of — TS/JS only.
  server.tool(
    'callees_of',
    'Return all callees invoked from a function/method name (TS/JS only).',
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
        limit: limit ?? 10,
        ...(project ? { project } : {}),
        ...(source ? { source } : {}),
        ...(kind ? { kind: kind as SdlcArtifactKind } : {}),
        rerankerEnabled: cfg.search.rerankerEnabled,
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
