import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resetConfigCache } from '../src/core/config.js';

let tmp: string;
const savedEnv = { ...process.env };
const savedCwd = process.cwd();

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ragolith-cfg-'));
  process.chdir(tmp);
  resetConfigCache();
  // Strip Weaviate env overrides between cases so we test the merge logic cleanly.
  for (const k of ['WEAVIATE_HOST', 'WEAVIATE_HTTP_PORT', 'WEAVIATE_GRPC_PORT', 'WEAVIATE_SECURE', 'WEAVIATE_API_KEY', 'RAGOLITH_CONFIG']) {
    delete process.env[k];
  }
});

afterEach(async () => {
  process.chdir(savedCwd);
  process.env = { ...savedEnv };
  resetConfigCache();
  await rm(tmp, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig();
    assert.equal(cfg.weaviate.host, 'localhost');
    assert.equal(cfg.weaviate.httpPort, 8080);
    assert.equal(cfg.weaviate.grpcPort, 50051);
    assert.equal(cfg.search.diversityPerFile, 3);
    assert.deepEqual(cfg.projects, []);
  });

  it('merges values from ragc.config.json on top of defaults', async () => {
    await writeFile(
      join(tmp, 'ragc.config.json'),
      JSON.stringify({
        weaviate: { host: 'weaviate.example.com', httpPort: 9999 },
        projects: [{ name: 'p1', repo: 'https://x/p1.git' }],
      }),
    );
    resetConfigCache();
    const cfg = loadConfig();
    assert.equal(cfg.weaviate.host, 'weaviate.example.com');
    assert.equal(cfg.weaviate.httpPort, 9999);
    // Untouched defaults are preserved.
    assert.equal(cfg.weaviate.grpcPort, 50051);
    assert.equal(cfg.projects.length, 1);
    assert.equal(cfg.projects[0]!.name, 'p1');
  });

  it('env vars override the file', async () => {
    await writeFile(
      join(tmp, 'ragc.config.json'),
      JSON.stringify({ weaviate: { host: 'file-host' } }),
    );
    process.env['WEAVIATE_HOST'] = 'env-host';
    process.env['WEAVIATE_HTTP_PORT'] = '7777';
    resetConfigCache();
    const cfg = loadConfig();
    assert.equal(cfg.weaviate.host, 'env-host');
    assert.equal(cfg.weaviate.httpPort, 7777);
  });

  it('respects RAGOLITH_CONFIG to point at a non-default file', async () => {
    const alt = join(tmp, 'alt.config.json');
    await writeFile(alt, JSON.stringify({ weaviate: { host: 'alt-host' } }));
    process.env['RAGOLITH_CONFIG'] = alt;
    resetConfigCache();
    const cfg = loadConfig();
    assert.equal(cfg.weaviate.host, 'alt-host');
  });

  it('caches across calls until resetConfigCache is called', async () => {
    const first = loadConfig();
    process.env['WEAVIATE_HOST'] = 'changed';
    const second = loadConfig();
    assert.equal(second.weaviate.host, first.weaviate.host); // cached
    resetConfigCache();
    const third = loadConfig();
    assert.equal(third.weaviate.host, 'changed');
  });
});
