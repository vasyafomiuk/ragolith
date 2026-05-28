import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetConfigCache } from '../src/core/config.js';
import { loadRegistry, markPushedToS3, recordSnapshot } from '../src/core/backups-registry.js';

let tmp: string;
const savedCwd = process.cwd();
const savedEnv = { ...process.env };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ragolith-bkreg-'));
  process.chdir(tmp);
  // The registry resolves its path off the loaded config's ingest.stateFile,
  // so we wipe the cache + relevant env vars to get a clean run each time.
  resetConfigCache();
  for (const k of ['RAGOLITH_CONFIG', 'WEAVIATE_HOST', 'WEAVIATE_HTTP_PORT']) {
    delete process.env[k];
  }
});

afterEach(async () => {
  process.chdir(savedCwd);
  process.env = { ...savedEnv };
  resetConfigCache();
  await rm(tmp, { recursive: true, force: true });
});

describe('backups-registry', () => {
  it('returns an empty list when no registry file exists', () => {
    const reg = loadRegistry();
    assert.deepEqual(reg.snapshots, []);
  });

  it('writes the registry under <stateDir>/backups.json on first record', async () => {
    await recordSnapshot({
      id: 'snap-a',
      backend: 'filesystem',
      createdAt: '2026-05-28T10:00:00.000Z',
      status: 'success',
    });
    // Default stateFile is .ragolith/data.json → registry at .ragolith/backups.json
    const path = resolve(tmp, '.ragolith/backups.json');
    assert.ok(existsSync(path), `expected registry at ${path}`);
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as {
      snapshots: { id: string }[];
    };
    assert.equal(parsed.snapshots.length, 1);
    assert.equal(parsed.snapshots[0]?.id, 'snap-a');
  });

  it('upserts by id rather than appending duplicates', async () => {
    await recordSnapshot({
      id: 'snap-b',
      backend: 'filesystem',
      createdAt: '2026-05-28T10:00:00.000Z',
      status: 'failed',
    });
    await recordSnapshot({
      id: 'snap-b',
      backend: 'filesystem',
      createdAt: '2026-05-28T10:05:00.000Z',
      status: 'success',
    });
    const reg = loadRegistry();
    assert.equal(reg.snapshots.length, 1);
    assert.equal(reg.snapshots[0]?.status, 'success');
    assert.equal(reg.snapshots[0]?.createdAt, '2026-05-28T10:05:00.000Z');
  });

  it('markPushedToS3 flips the flag on an existing record', async () => {
    await recordSnapshot({
      id: 'snap-c',
      backend: 'filesystem',
      createdAt: '2026-05-28T10:00:00.000Z',
      status: 'success',
    });
    await markPushedToS3('snap-c', 'filesystem');
    const reg = loadRegistry();
    assert.equal(reg.snapshots[0]?.pushedToS3, true);
  });

  it('markPushedToS3 adds a stub if the id was untracked', async () => {
    await markPushedToS3('snap-orphan', 's3');
    const reg = loadRegistry();
    assert.equal(reg.snapshots.length, 1);
    assert.equal(reg.snapshots[0]?.id, 'snap-orphan');
    assert.equal(reg.snapshots[0]?.backend, 's3');
    assert.equal(reg.snapshots[0]?.pushedToS3, true);
    assert.equal(reg.snapshots[0]?.status, 'success');
  });

  it('returns an empty list on corrupt JSON instead of throwing', async () => {
    // Seed a junk registry file at the path loadRegistry expects.
    const dir = resolve(tmp, '.ragolith');
    await rm(dir, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await (
      await import('node:fs/promises')
    ).writeFile(join(dir, 'backups.json'), '{ not valid json', 'utf-8');
    const reg = loadRegistry();
    assert.deepEqual(reg.snapshots, []);
  });
});
