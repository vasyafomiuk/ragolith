// End-to-end integration test against a live Weaviate stack.
//
// Brings up a temp git repo with three TS files, runs the real ingest CLI,
// then talks to the real MCP server over stdio (the way an actual MCP client
// would) and asserts the search, symbol, and project tools return what we
// expect.
//
// Requirements:
//   - Weaviate + t2v-transformers running on localhost:8080 / :50051.
//     Locally: `npm run weaviate:up` then wait ~30s for the embedder to warm up.
//     In CI: handled by .github/workflows/ci.yml.
//   - `npm run build` has run (we spawn dist/cli/ingest.js and dist/mcp/server.js).

import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WEAVIATE_HTTP = 'http://localhost:8080';
const READY_TIMEOUT_MS = 180_000; // first-run image pull + embedder warmup can be slow

interface ToolContent {
  type: string;
  text: string;
}

async function waitForWeaviate(timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${WEAVIATE_HTTP}/v1/.well-known/ready`);
      if (r.ok) return;
      lastErr = `status ${r.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Weaviate did not become ready in ${timeoutMs}ms (last: ${String(lastErr)})`);
}

function parseToolResult<T>(result: { content: unknown }): T {
  const arr = result.content as ToolContent[];
  const text = arr[0]?.text ?? '';
  return JSON.parse(text) as T;
}

let workdir: string;
let configPath: string;
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

before(async () => {
  await waitForWeaviate(READY_TIMEOUT_MS);

  // Temp fixture: a tiny TS project, init'd as a git repo so the ingest pipeline
  // can resolve HEAD on it.
  workdir = await mkdtemp(join(tmpdir(), 'ragolith-it-'));
  const repoDir = join(workdir, 'fixture');
  await mkdir(join(repoDir, 'src'), { recursive: true });

  await writeFile(
    join(repoDir, 'src/auth.ts'),
    `export function authenticate(user: string): boolean {
  return user.length > 0;
}

export function logout(userId: string): void {
  // Clear the session for the given user.
  void userId;
}
`,
  );
  await writeFile(
    join(repoDir, 'src/config.ts'),
    `export class Config {
  load(): void {
    /* read the file */
  }
  save(): void {
    /* write the file */
  }
}
`,
  );
  await writeFile(
    join(repoDir, 'src/utils.ts'),
    `export function parseDate(s: string): Date {
  return new Date(s);
}
`,
  );

  for (const [cmd, ...args] of [
    ['git', 'init', '-q', '-b', 'main'],
    ['git', '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '.'],
    ['git', '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'init'],
  ] as [string, ...string[]][]) {
    const r = spawnSync(cmd, args, { cwd: repoDir });
    if (r.status !== 0) {
      throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr.toString()}`);
    }
  }

  configPath = join(workdir, 'ragc.config.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        weaviate: { host: 'localhost', httpPort: 8080, grpcPort: 50051, secure: false },
        ingest: {
          workDir: join(workdir, '.ragolith/repos'),
          stateFile: join(workdir, '.ragolith/data.json'),
          extensions: ['.ts'],
          maxFileBytes: 1_048_576,
        },
        search: {
          overFetch: 2,
          diversityPerFile: 3,
          // Reranker is in the stack but disabling it here makes the test ~2s faster
          // and still exercises the BM25 + vector hybrid path.
          rerankerEnabled: false,
        },
        repos: [{ name: 'fixture', localPath: repoDir, subPaths: ['src'] }],
        documents: [],
        backup: { backend: 'filesystem' },
      },
      null,
      2,
    ),
  );

  // Run the real ingest CLI as a child process — this exercises the CLI's argv
  // parsing, batch loop, and Weaviate connection in addition to the chunkers.
  const ingestPath = resolve('dist/cli/ingest.js');
  const ingest = spawnSync('node', [ingestPath], {
    env: { ...process.env, RAGOLITH_CONFIG: configPath },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (ingest.status !== 0) {
    throw new Error(`ingest exited with code ${ingest.status}`);
  }

  // Connect to a real MCP server over stdio — same path any LLM client takes.
  const serverPath = resolve('dist/mcp/server.js');
  mcpTransport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...(process.env as Record<string, string>), RAGOLITH_CONFIG: configPath },
  });
  mcpClient = new Client(
    { name: 'ragolith-integration-test', version: '0.1.0' },
    { capabilities: {} },
  );
  await mcpClient.connect(mcpTransport);
});

after(async () => {
  if (mcpClient) await mcpClient.close();
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe('end-to-end via MCP', () => {
  it('lists the 23 tools the server advertises', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.equal(tools.length, 23, `expected 23 tools, got ${tools.length}: ${names.join(', ')}`);
    assert.ok(names.includes('search'));
    assert.ok(names.includes('find_symbol'));
    assert.ok(names.includes('list_projects'));
    // Parity tools.
    for (const t of [
      'trace_flow',
      'compare_systems',
      'search_code_bulk',
      'get_full_file',
      'search_code_by_file',
      'get_project_structure',
    ]) {
      assert.ok(names.includes(t), `expected tool ${t}`);
    }
  });

  it('search returns hits for an indexed identifier', async () => {
    const result = await mcpClient.callTool({
      name: 'search',
      arguments: { query: 'authenticate user', limit: 5 },
    });
    const hits = parseToolResult<{ content: string; file_path: string }[]>(result);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length > 0, 'expected ≥1 search hit');
    assert.ok(
      hits.some((h) => h.content.includes('authenticate')),
      `expected an "authenticate" hit, got: ${hits.map((h) => h.file_path).join(', ')}`,
    );
  });

  it('find_symbol returns the exact function declaration', async () => {
    const result = await mcpClient.callTool({
      name: 'find_symbol',
      arguments: { name: 'authenticate' },
    });
    const syms = parseToolResult<{ name: string; kind: string; file_path: string }[]>(result);
    assert.ok(syms.length >= 1, `expected ≥1 symbol, got ${syms.length}`);
    const auth = syms.find((s) => s.name === 'authenticate');
    assert.ok(auth, 'expected a symbol named "authenticate"');
    assert.equal(auth.kind, 'function');
    assert.match(auth.file_path, /auth\.ts$/);
  });

  it('find_symbol by prefix finds Config (class) and parseDate (function)', async () => {
    const conf = parseToolResult<{ name: string; kind: string }[]>(
      await mcpClient.callTool({
        name: 'find_symbol',
        arguments: { name: 'Conf', prefix: true },
      }),
    );
    assert.ok(conf.some((s) => s.name === 'Config' && s.kind === 'class'));

    const parse = parseToolResult<{ name: string; kind: string }[]>(
      await mcpClient.callTool({
        name: 'find_symbol',
        arguments: { name: 'parse', prefix: true },
      }),
    );
    assert.ok(parse.some((s) => s.name === 'parseDate' && s.kind === 'function'));
  });

  it('file_structure lists symbols declared in a file', async () => {
    const result = await mcpClient.callTool({
      name: 'file_structure',
      arguments: { file_path: 'src/config.ts', project: 'fixture' },
    });
    const syms = parseToolResult<{ name: string; kind: string }[]>(result);
    const names = syms.map((s) => s.name).sort();
    assert.ok(names.includes('Config'));
    assert.ok(names.includes('load'));
    assert.ok(names.includes('save'));
  });

  it('list_projects includes the fixture with a commit SHA', async () => {
    const result = await mcpClient.callTool({ name: 'list_projects', arguments: {} });
    const data = parseToolResult<{
      projects: { name: string; commit_sha: string }[];
    }>(result);
    const fixture = data.projects.find((p) => p.name === 'fixture');
    assert.ok(fixture, 'expected fixture in list_projects');
    assert.match(fixture.commit_sha, /^[a-f0-9]{40}$/, 'expected a 40-char SHA');
  });

  it('callees_of returns the calls made inside a function (TS only)', async () => {
    // authenticate doesn't call anything internal, but it does call user.length
    // which the AST walker records as `length` with call_type=method. The test
    // is intentionally loose — we just want to confirm the call-edge table is
    // populated and queryable.
    const result = await mcpClient.callTool({
      name: 'callees_of',
      arguments: { caller: 'authenticate' },
    });
    const edges = parseToolResult<{ caller: string; callee: string }[]>(result);
    // Could be 0 if the function body has no calls; main check is that the
    // tool returns a well-formed array without throwing.
    assert.ok(Array.isArray(edges));
  });

  it('get_project_structure groups the fixture files by directory', async () => {
    const s = parseToolResult<{
      totalFiles: number;
      directories: { dir: string; paths: string[] }[];
    }>(
      await mcpClient.callTool({
        name: 'get_project_structure',
        arguments: { project: 'fixture' },
      }),
    );
    assert.ok(s.totalFiles >= 3, `expected ≥3 files, got ${s.totalFiles}`);
    const src = s.directories.find((d) => d.dir === 'src');
    assert.ok(src, 'expected a src/ directory');
    assert.ok(src.paths.some((p) => p.endsWith('auth.ts')));
  });

  it('get_full_file reconstructs an indexed file', async () => {
    const f = parseToolResult<{ content: string; chunks: number; error?: string }>(
      await mcpClient.callTool({
        name: 'get_full_file',
        arguments: { file_path: 'src/config.ts', project: 'fixture' },
      }),
    );
    assert.ok(!f.error, `unexpected error: ${f.error}`);
    assert.ok(f.chunks >= 1);
    assert.match(f.content, /class Config/);
  });

  it('search_code_by_file scopes a query to a path', async () => {
    const hits = parseToolResult<{ file_path: string }[]>(
      await mcpClient.callTool({
        name: 'search_code_by_file',
        arguments: { path: 'config', query: 'load save', project: 'fixture' },
      }),
    );
    assert.ok(Array.isArray(hits));
    assert.ok(
      hits.every((h) => /config\.ts$/.test(h.file_path)),
      'all hits should come from config.ts',
    );
  });

  it('search_code_by_file with no query lists chunks in the path', async () => {
    const rows = parseToolResult<{ file_path: string }[]>(
      await mcpClient.callTool({
        name: 'search_code_by_file',
        arguments: { path: 'src/utils.ts', project: 'fixture' },
      }),
    );
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => /utils\.ts$/.test(r.file_path)));
  });

  it('search_code_bulk merges and dedupes multiple queries', async () => {
    const res = parseToolResult<{
      total: number;
      hits: { file_path: string; start_line: number; end_line: number; matched_query: string }[];
    }>(
      await mcpClient.callTool({
        name: 'search_code_bulk',
        arguments: { queries: ['authenticate', 'Config'], project: 'fixture', limit_per_query: 5 },
      }),
    );
    assert.ok(res.total >= 1);
    const keys = res.hits.map((h) => `${h.file_path}:${h.start_line}-${h.end_line}`);
    assert.equal(new Set(keys).size, keys.length, 'expected de-duplicated hits');
    assert.ok(res.hits.every((h) => typeof h.matched_query === 'string'));
  });

  it('trace_flow returns a well-formed traversal from a symbol', async () => {
    const r = parseToolResult<{
      center: string;
      nodes: string[];
      hops: unknown[];
      truncated: boolean;
    }>(
      await mcpClient.callTool({
        name: 'trace_flow',
        arguments: {
          symbol: 'authenticate',
          direction: 'callees',
          max_hops: 2,
          project: 'fixture',
        },
      }),
    );
    assert.equal(r.center, 'authenticate');
    assert.ok(r.nodes.includes('authenticate'));
    assert.ok(Array.isArray(r.hops));
  });

  it('compare_systems returns two labelled result sets', async () => {
    const r = parseToolResult<{
      a: { project: string; hits: unknown[] };
      b: { project: string; hits: unknown[] };
    }>(
      await mcpClient.callTool({
        name: 'compare_systems',
        arguments: { query: 'authenticate', project_a: 'fixture', project_b: 'fixture' },
      }),
    );
    assert.equal(r.a.project, 'fixture');
    assert.equal(r.b.project, 'fixture');
    assert.ok(Array.isArray(r.a.hits) && Array.isArray(r.b.hits));
  });
});
