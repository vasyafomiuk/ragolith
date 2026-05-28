// Pure-logic tests for the eval scoring + golden-set loader.
//
// The live runEval() path is integration-only (needs Weaviate). We exercise
// scoreQuery directly and the JSON loader against a tmp file.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGoldenSet, scoreQuery, type GoldenQuery } from '../src/core/eval.js';

describe('scoreQuery', () => {
  const q: GoldenQuery = {
    id: 'auth',
    query: 'authentication',
    expect: ['src/auth.ts', 'src/login.ts'],
  };

  it('full recall when every expected match surfaces', () => {
    const r = scoreQuery(q, ['src/auth.ts', 'src/login.ts', 'src/other.ts'], 10);
    assert.equal(r.hits, 2);
    assert.equal(r.recall, 1);
    assert.equal(r.reciprocalRank, 1); // first expected match at rank 1
  });

  it('partial recall when only some expected matches surface', () => {
    const r = scoreQuery(q, ['src/auth.ts', 'src/other.ts'], 10);
    assert.equal(r.hits, 1);
    assert.equal(r.recall, 0.5);
    assert.equal(r.reciprocalRank, 1);
  });

  it('zero when nothing relevant surfaces', () => {
    const r = scoreQuery(q, ['src/unrelated.ts', 'src/random.md'], 10);
    assert.equal(r.hits, 0);
    assert.equal(r.recall, 0);
    assert.equal(r.reciprocalRank, 0);
  });

  it('matches expected substrings, not just exact paths', () => {
    const r = scoreQuery(
      { id: 'p', query: 'q', expect: ['auth.ts'] },
      ['my-project/src/auth.ts'],
      10,
    );
    assert.equal(r.recall, 1, 'substring match should count');
  });

  it('MRR uses the rank of the FIRST expected match', () => {
    const r = scoreQuery(
      { id: 'p', query: 'q', expect: ['auth.ts'] },
      ['unrelated1.ts', 'unrelated2.ts', 'src/auth.ts'],
      10,
    );
    assert.equal(r.reciprocalRank, 1 / 3);
  });
});

describe('loadGoldenSet', () => {
  it('parses a valid JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-'));
    try {
      const path = join(dir, 'q.json');
      await writeFile(
        path,
        JSON.stringify({
          queries: [{ id: 'a', query: 'foo', expect: ['x.ts'] }],
          k: 5,
        }),
      );
      const c = await loadGoldenSet(path);
      assert.equal(c.queries.length, 1);
      assert.equal(c.k, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file without a queries array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-'));
    try {
      const path = join(dir, 'q.json');
      await writeFile(path, JSON.stringify({ not_queries: [] }));
      await assert.rejects(loadGoldenSet(path), /missing.*queries/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file with malformed entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-'));
    try {
      const path = join(dir, 'q.json');
      // Missing 'expect' field.
      await writeFile(path, JSON.stringify({ queries: [{ id: 'a', query: 'foo' }] }));
      await assert.rejects(loadGoldenSet(path), /malformed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
