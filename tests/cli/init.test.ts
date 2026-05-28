// Pure-function tests for the init wizard's config-building bits.
// The interactive readline flow is not unit-tested — its behavior is exercised
// by spawning `ragolith-init --yes` in the smoke test below.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildConfig, defaultAnswers } from '../../src/cli/init.js';
import type { RagolithConfig } from '../../src/core/types.js';

describe('defaultAnswers', () => {
  it('returns a config that satisfies the RagolithConfig shape', () => {
    const a = defaultAnswers();
    assert.equal(a.weaviate.host, 'localhost');
    assert.equal(a.weaviate.httpPort, 8080);
    assert.equal(a.weaviate.grpcPort, 50051);
    assert.equal(a.weaviate.secure, false);
    assert.ok(Array.isArray(a.ingest.extensions));
    assert.ok(a.ingest.extensions.includes('.ts'));
    assert.equal(a.search.rerankerEnabled, true);
    assert.deepEqual(a.projects, []);
    assert.deepEqual(a.files, []);
    assert.equal(a.backup.backend, 'filesystem');
  });

  it('returns a fresh object each call (no shared mutable refs)', () => {
    const a = defaultAnswers();
    const b = defaultAnswers();
    a.projects.push({ name: 'mutation' });
    a.ingest.extensions.push('.bogus');
    assert.equal(b.projects.length, 0);
    assert.ok(!b.ingest.extensions.includes('.bogus'));
  });
});

describe('buildConfig', () => {
  it('passes user-supplied projects + files through verbatim', () => {
    const answers = defaultAnswers();
    answers.projects.push({
      name: 'my-app',
      repo: 'https://github.com/foo/my-app.git',
      branch: 'main',
      subPaths: ['src', 'docs'],
    });
    answers.files.push({ name: 'spec', path: '/abs/spec.pdf' });
    const cfg: RagolithConfig = buildConfig(answers);
    assert.equal(cfg.projects.length, 1);
    assert.equal(cfg.projects[0]!.name, 'my-app');
    assert.deepEqual(cfg.projects[0]!.subPaths, ['src', 'docs']);
    assert.equal(cfg.files.length, 1);
    assert.equal(cfg.files[0]!.path, '/abs/spec.pdf');
  });

  it('preserves rerankerEnabled flag changes', () => {
    const answers = defaultAnswers();
    answers.search.rerankerEnabled = false;
    const cfg = buildConfig(answers);
    assert.equal(cfg.search.rerankerEnabled, false);
  });
});

// End-to-end smoke test: spawn the built CLI in --yes mode, confirm it writes
// a valid JSON config and exits 0. Needs `npm run build` to have run; CI does
// this in the pipeline, and locally `npm run all` runs build before tests.
describe('ragolith-init --yes (smoke)', () => {
  it('writes a default config and exits 0', async () => {
    const distInit = resolve('dist/cli/init.js');
    const tmp = await mkdtemp(join(tmpdir(), 'ragolith-init-'));
    try {
      const outPath = join(tmp, 'ragc.config.json');
      const r = spawnSync('node', [distInit, '--yes', '-o', outPath], {
        encoding: 'utf-8',
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr:\n${r.stderr}`);
      const cfg = JSON.parse(await readFile(outPath, 'utf-8')) as RagolithConfig;
      assert.equal(cfg.weaviate.host, 'localhost');
      assert.deepEqual(cfg.projects, []);
      assert.ok(cfg.ingest.extensions.includes('.ts'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing config without --force', async () => {
    const distInit = resolve('dist/cli/init.js');
    const tmp = await mkdtemp(join(tmpdir(), 'ragolith-init-'));
    try {
      const outPath = join(tmp, 'ragc.config.json');
      await writeFile(outPath, '{"weaviate":{"host":"existing"}}');
      const r = spawnSync('node', [distInit, '--yes', '-o', outPath], {
        encoding: 'utf-8',
      });
      assert.notEqual(r.status, 0, 'expected non-zero exit');
      assert.match(r.stderr, /already exists/);
      // File should be untouched.
      const after = await readFile(outPath, 'utf-8');
      assert.match(after, /"existing"/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('overwrites with --force', async () => {
    const distInit = resolve('dist/cli/init.js');
    const tmp = await mkdtemp(join(tmpdir(), 'ragolith-init-'));
    try {
      const outPath = join(tmp, 'ragc.config.json');
      await writeFile(outPath, '{"weaviate":{"host":"existing"}}');
      const r = spawnSync('node', [distInit, '--yes', '--force', '-o', outPath], {
        encoding: 'utf-8',
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr:\n${r.stderr}`);
      const after = await readFile(outPath, 'utf-8');
      const cfg = JSON.parse(after) as RagolithConfig;
      assert.equal(cfg.weaviate.host, 'localhost'); // back to defaults
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
