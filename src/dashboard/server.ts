#!/usr/bin/env node
// Dashboard HTTP server.
//
// Uses node:http only — no Express, no Fastify, no build step. Routes:
//
//   GET  /                          → public/index.html
//   GET  /app.js                    → public/app.js
//   GET  /styles.css                → public/styles.css
//   GET  /api/health                → HealthStatus JSON
//   GET  /api/projects              → ProjectSummary[]
//   GET  /api/projects/:name/files  → file list for one project
//   DELETE /api/projects/:name      → drop the project's chunks from Weaviate
//   POST /api/search                → SearchHit[] for the supplied query
//   GET  /api/config                → current ragc.config.json (+ defaults)
//   PUT  /api/config                → write a new ragc.config.json (atomic)
//   POST /api/ingest                → spawn ragolith-ingest as a job
//   POST /api/backup                → spawn ragolith-backup as a job
//   GET  /api/backups               → SnapshotRecord[] from the local registry
//   GET  /api/jobs/active           → currently-running job or { id: null }
//   GET  /api/jobs/stream           → SSE feed of job start/log/exit events
//
// Binds to 127.0.0.1 by default so the dashboard is not exposed on the
// network — this is a single-user localhost tool. Override with --host
// 0.0.0.0 if you really want to share, but be aware Weaviate's anonymous
// access (the docker-compose default) means anyone on your network could
// run searches against your index.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { spawn } from 'node:child_process';

import {
  deleteProject,
  getActiveJob,
  health,
  listSnapshots,
  projects,
  projectFiles,
  readConfig,
  runSearch,
  startBackup,
  startIngest,
  subscribeJobs,
  writeConfig,
  type BackupOptions,
  type IngestOptions,
  type SearchRequest,
} from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), 'application/json; charset=utf-8');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = req.url === '/' ? '/index.html' : (req.url ?? '/');
  // Strip query string, normalize, and refuse anything that escapes PUBLIC_DIR.
  const cleanPath = normalize(urlPath.split('?')[0] ?? '/').replace(/^[/\\]+/, '');
  const absPath = resolve(PUBLIC_DIR, cleanPath);
  if (!absPath.startsWith(PUBLIC_DIR + sep) && absPath !== PUBLIC_DIR) {
    send(res, 403, 'Forbidden', 'text/plain');
    return;
  }
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      send(res, 404, 'Not found', 'text/plain');
      return;
    }
    const body = await readFile(absPath);
    const mime = MIME[extname(absPath)] ?? 'application/octet-stream';
    send(res, 200, body, mime);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // API routing first.
  if (url.startsWith('/api/')) {
    try {
      if (method === 'GET' && url === '/api/health') {
        sendJson(res, 200, await health());
        return;
      }
      if (method === 'GET' && url === '/api/projects') {
        sendJson(res, 200, await projects());
        return;
      }
      const projMatch = /^\/api\/projects\/([^/?]+)\/files$/.exec(url);
      if (method === 'GET' && projMatch) {
        // The regex has exactly one capture group; if it matched, [1] exists.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const name = decodeURIComponent(projMatch[1]!);
        sendJson(res, 200, await projectFiles(name));
        return;
      }
      const projDeleteMatch = /^\/api\/projects\/([^/?]+)$/.exec(url);
      if (method === 'DELETE' && projDeleteMatch) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const name = decodeURIComponent(projDeleteMatch[1]!);
        try {
          sendJson(res, 200, await deleteProject(name));
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (method === 'POST' && url === '/api/search') {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as SearchRequest;
        if (!body.query || typeof body.query !== 'string') {
          sendJson(res, 400, { error: 'missing "query" string in body' });
          return;
        }
        sendJson(res, 200, await runSearch(body));
        return;
      }
      if (method === 'GET' && url === '/api/config') {
        sendJson(res, 200, readConfig());
        return;
      }
      if (method === 'POST' && url === '/api/ingest') {
        const raw = await readBody(req);
        let body: IngestOptions = {};
        if (raw.trim()) {
          try {
            body = JSON.parse(raw) as IngestOptions;
          } catch (err) {
            sendJson(res, 400, { error: `body is not valid JSON: ${String(err)}` });
            return;
          }
        }
        try {
          const job = startIngest(body);
          sendJson(res, 200, { jobId: job.id, status: job.status, args: job.args });
        } catch (err) {
          sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (method === 'GET' && url === '/api/backups') {
        sendJson(res, 200, { snapshots: listSnapshots() });
        return;
      }
      if (method === 'POST' && url === '/api/backup') {
        const raw = await readBody(req);
        let body: BackupOptions | undefined;
        if (raw.trim()) {
          try {
            body = JSON.parse(raw) as BackupOptions;
          } catch (err) {
            sendJson(res, 400, { error: `body is not valid JSON: ${String(err)}` });
            return;
          }
        }
        if (!body || !body.command) {
          sendJson(res, 400, { error: 'missing "command" (create|restore|verify|push|pull)' });
          return;
        }
        try {
          const job = startBackup(body);
          sendJson(res, 200, { jobId: job.id, status: job.status, args: job.args });
        } catch (err) {
          // 400 for bad args (validation), 409 for "already running" — they
          // share the same throw site so we discriminate on the message text.
          const msg = err instanceof Error ? err.message : String(err);
          const status = msg.startsWith('a ') && msg.includes('already running') ? 409 : 400;
          sendJson(res, status, { error: msg });
        }
        return;
      }
      if (method === 'GET' && url === '/api/jobs/active') {
        const job = getActiveJob();
        sendJson(res, 200, job ?? { id: null });
        return;
      }
      if (method === 'GET' && url === '/api/jobs/stream') {
        // Server-Sent Events: text/event-stream + `data:` lines + blank-line
        // separators. Browsers' EventSource handles reconnect automatically.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Tell intermediate proxies (none locally, but harmless) not to buffer.
          'x-accel-buffering': 'no',
        });
        // Send a comment line as an opening probe; browsers consider the
        // connection healthy as soon as they see any byte.
        res.write(': stream open\n\n');
        const unsubscribe = subscribeJobs((payload) => {
          // EventSource doesn't tolerate raw newlines in data; JSON encode
          // gives us a single safe line per event.
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        });
        const cleanup = (): void => {
          unsubscribe();
          // Don't close the response twice — Node will throw.
          if (!res.writableEnded) res.end();
        };
        req.on('close', cleanup);
        req.on('aborted', cleanup);
        return;
      }
      if (method === 'PUT' && url === '/api/config') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch (err) {
          sendJson(res, 400, { error: `body is not valid JSON: ${String(err)}` });
          return;
        }
        try {
          const result = await writeConfig(body);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      sendJson(res, 404, { error: 'unknown route' });
      return;
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      sendJson(res, 500, { error: msg });
      return;
    }
  }

  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, 'Method not allowed', 'text/plain');
    return;
  }
  await serveStatic(req, res);
}

function openInBrowser(url: string): void {
  // macOS / Linux / Windows in three short branches. No external deps.
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

interface DashboardOptions {
  port: number;
  host: string;
  open: boolean;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('ragolith-dashboard')
    .description('Browse and query your ragolith index from a local web UI.')
    .option('-p, --port <port>', 'Port to listen on', (v) => Number.parseInt(v, 10), 7777)
    .option('-h, --host <host>', 'Host to bind (127.0.0.1 is localhost-only)', '127.0.0.1')
    .option('-o, --open', 'Open the dashboard in your default browser', false)
    .parse(process.argv);

  const opts = program.opts<DashboardOptions>();
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        send(res, 500, msg, 'text/plain');
      } catch {
        // response already started — swallow.
      }
    });
  });

  server.listen(opts.port, opts.host, () => {
    const url = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`;
    process.stderr.write(`[ragolith-dashboard] listening on ${url}\n`);
    if (opts.open) openInBrowser(url);
  });

  const shutdown = (): void => {
    process.stderr.write('[ragolith-dashboard] shutting down\n');
    server.close(() => process.exit(0));
    // Force-exit if a hanging keep-alive socket prevents close.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[ragolith-dashboard] fatal: ${msg}\n`);
  process.exit(1);
});
