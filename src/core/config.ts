// Config loader: env > ragc.config.json > defaults.
//
// Lookup order for the config file:
//   1. RAGOLITH_CONFIG env var (absolute path)
//   2. ./ragc.config.json in the current working directory
//   3. defaults only
//
// Env overrides (applied last):
//   WEAVIATE_HOST, WEAVIATE_HTTP_PORT, WEAVIATE_GRPC_PORT, WEAVIATE_SECURE, WEAVIATE_API_KEY

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RagolithConfig } from './types.js';

const DEFAULTS: RagolithConfig = {
  weaviate: {
    host: 'localhost',
    httpPort: 8080,
    grpcPort: 50051,
    secure: false,
  },
  ingest: {
    workDir: '.ragolith/repos',
    stateFile: '.ragolith/data.json',
    extensions: [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.java',
      '.cs',
      '.sql',
      '.py',
      '.go',
      '.rs',
      '.rb',
      '.php',
      '.md',
      '.mdx',
      '.txt',
      '.pdf',
      '.docx',
    ],
    maxFileBytes: 1_048_576,
  },
  search: {
    overFetch: 2,
    diversityPerFile: 3,
    rerankerEnabled: true,
  },
  projects: [],
  files: [],
  backup: {
    backend: 'filesystem',
  },
};

function readJsonIfExists(path: string): Partial<RagolithConfig> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as Partial<RagolithConfig>;
}

function deepMerge<T>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over)) {
    const baseVal = (base as Record<string, unknown>)[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal, value as Partial<typeof baseVal>);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

function applyEnvOverrides(cfg: RagolithConfig): RagolithConfig {
  const env = process.env;
  const next: RagolithConfig = {
    ...cfg,
    weaviate: { ...cfg.weaviate },
  };
  if (env['WEAVIATE_HOST']) next.weaviate.host = env['WEAVIATE_HOST'];
  if (env['WEAVIATE_HTTP_PORT']) next.weaviate.httpPort = Number(env['WEAVIATE_HTTP_PORT']);
  if (env['WEAVIATE_GRPC_PORT']) next.weaviate.grpcPort = Number(env['WEAVIATE_GRPC_PORT']);
  if (env['WEAVIATE_SECURE']) next.weaviate.secure = env['WEAVIATE_SECURE'] === 'true';
  if (env['WEAVIATE_API_KEY']) next.weaviate.apiKey = env['WEAVIATE_API_KEY'];
  return next;
}

/**
 * Resolve the on-disk path of the config file. Honours `RAGOLITH_CONFIG`
 * (absolute path expected), otherwise falls back to `ragc.config.json` in the
 * current working directory.
 *
 * Returns the path the file *would* live at — not whether it exists. Callers
 * who care about existence should `existsSync(configFilePath())`.
 */
export function configFilePath(): string {
  return process.env['RAGOLITH_CONFIG']
    ? resolve(process.env['RAGOLITH_CONFIG'])
    : resolve(process.cwd(), 'ragc.config.json');
}

let cached: RagolithConfig | undefined;

export function loadConfig(): RagolithConfig {
  if (cached) return cached;
  const path = configFilePath();
  const fromFile = readJsonIfExists(path);
  const merged = deepMerge(DEFAULTS, fromFile);
  cached = applyEnvOverrides(merged);
  return cached;
}

/** Reset the cache — used by tests and the CLI when -c is passed. */
export function resetConfigCache(): void {
  cached = undefined;
}
