import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkSql } from '../../src/core/chunkers/sql-chunker.js';

describe('chunkSql', () => {
  it('splits on statement boundaries', () => {
    const src = `
SELECT 1;
SELECT 2;
`;
    const result = chunkSql(src, { filePath: 'q.sql', project: 'p' });
    assert.equal(result.chunks.length, 2);
    for (const c of result.chunks) assert.equal(c.chunk_type, 'statement');
  });

  it('does not split inside a single-quoted string', () => {
    const src = `INSERT INTO t VALUES ('a;b;c'); SELECT 1;`;
    const result = chunkSql(src, { filePath: 'q.sql', project: 'p' });
    assert.equal(result.chunks.length, 2);
    assert.match(result.chunks[0]!.raw_content, /a;b;c/);
  });

  it('does not split inside a line comment', () => {
    const src = `-- foo;bar;baz\nSELECT 1;`;
    const result = chunkSql(src, { filePath: 'q.sql', project: 'p' });
    // Comment + the SELECT collapse into one statement.
    assert.equal(result.chunks.length, 1);
    assert.match(result.chunks[0]!.raw_content, /SELECT 1/);
  });

  it('does not split inside a block comment', () => {
    const src = `/* a; b; c */ SELECT 1; SELECT 2;`;
    const result = chunkSql(src, { filePath: 'q.sql', project: 'p' });
    assert.equal(result.chunks.length, 2);
  });

  it('falls back to the line-based chunker on whitespace-only input', () => {
    const result = chunkSql('   \n   \n', { filePath: 'q.sql', project: 'p' });
    // No statements found → fallback path returns 0 chunks for empty content.
    assert.equal(result.chunks.length, 0);
  });
});
