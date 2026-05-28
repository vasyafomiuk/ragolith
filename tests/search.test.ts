// Unit tests for the pure helpers in the search pipeline.
// The end-to-end `search()` function is integration-only (needs Weaviate).

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyAlpha,
  expandQuery,
  autocut,
  diversityFilter,
} from '../src/core/search.js';

describe('classifyAlpha', () => {
  it('treats an identifier as keyword-heavy (low alpha)', () => {
    assert.ok(classifyAlpha('parseConfig') < 0.5);
    assert.ok(classifyAlpha('Module.foo') < 0.5);
  });

  it('treats a natural-language question as semantic-heavy (high alpha)', () => {
    assert.ok(classifyAlpha('how does the ingest pipeline work?') > 0.7);
    assert.ok(classifyAlpha('explain the search step') > 0.7);
  });

  it('treats short generic queries as roughly balanced', () => {
    const alpha = classifyAlpha('cache invalidation');
    assert.ok(alpha >= 0.3 && alpha <= 0.7);
  });
});

describe('expandQuery', () => {
  it('splits camelCase tokens into their parts', () => {
    const out = expandQuery('parseConfig');
    assert.match(out, /parse/);
    assert.match(out, /Config/);
  });

  it('expands a known abbreviation via the synonym map', () => {
    const out = expandQuery('auth flow');
    assert.match(out, /authentication/);
  });

  it('returns the original query unchanged when nothing to expand', () => {
    assert.equal(expandQuery('zebra'), 'zebra');
  });
});

describe('autocut', () => {
  it('keeps everything when scores are smooth', () => {
    assert.equal(autocut([0.9, 0.89, 0.88, 0.87]), 4);
  });

  it('cuts at the largest score gap', () => {
    // Big drop between idx 1 and idx 2.
    assert.equal(autocut([0.95, 0.93, 0.42, 0.40]), 2);
  });

  it('handles empty input', () => {
    assert.equal(autocut([]), 0);
  });

  it('keeps a single hit', () => {
    assert.equal(autocut([0.7]), 1);
  });
});

describe('diversityFilter', () => {
  it('caps results per file at the configured limit', () => {
    const hits = [
      { file_path: 'a.ts' },
      { file_path: 'a.ts' },
      { file_path: 'a.ts' },
      { file_path: 'a.ts' },
      { file_path: 'b.ts' },
    ];
    const out = diversityFilter(hits, 2);
    const aCount = out.filter((h) => h.file_path === 'a.ts').length;
    const bCount = out.filter((h) => h.file_path === 'b.ts').length;
    assert.equal(aCount, 2);
    assert.equal(bCount, 1);
  });

  it('preserves input order within the cap', () => {
    const hits = [
      { file_path: 'a.ts', tag: 1 },
      { file_path: 'a.ts', tag: 2 },
      { file_path: 'b.ts', tag: 3 },
    ];
    const out = diversityFilter(hits, 5);
    assert.deepEqual(out.map((h) => h.tag), [1, 2, 3]);
  });
});
