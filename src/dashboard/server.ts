#!/usr/bin/env node
// Dashboard HTTP server.
//
// Uses node:http only — no Express, no Fastify, no build step. Routes:
//
//   GET  /                       → public/index.html
//   GET  /app.js                 → public/app.js
//   GET  /styles.css             → public/styles.css
//   GET  /api/health             → HealthStatus JSON
//   GET  /api/projects           → ProjectSummary[]
//   GET  /api/projects/:name     → file list for one project
//   POST /api/search             → SearchHit[] for the supplied query
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

import { health, projects, projectFiles, runSearch, type SearchRequest } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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
