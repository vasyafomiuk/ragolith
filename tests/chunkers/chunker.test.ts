import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  chunkFallback,
  applyProjectPrefix,
} from '../../src/core/chunkers/chunker.js';

describe('chunkFallback', () => {
  it('emits no chunks for empty input', () => {
    const result = chunkFallback('', {
      filePath: 'empty.txt',
      project: 'p',
      language: 'text',
    });
    assert.equal(result.chunks.length, 0);
    assert.equal(result.symbols.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it('emits a single chunk for a short file', () => {
    const result = chunkFallback('hello\nworld\n', {
      filePath: 'short.txt',
      project: 'p',
      language: 'text',
    });
    assert.equal(result.chunks.length, 1);
    const chunk = result.chunks[0]!;
    assert.equal(chunk.start_line, 1);
    assert.equal(chunk.chunk_type, 'fallback');
    assert.equal(chunk.project, 'p');
    assert.equal(chunk.language, 'text');
    assert.match(chunk.raw_content, /hello/);
  });

  it('splits a long file into multiple chunks with overlap', () => {
    // Build a file ~9000 chars so we cross the 4000-char target twice.
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i.toString().padStart(3, '0')}-${'x'.repeat(20)}`);
    const content = lines.join('\n');

    const result = chunkFallback(content, {
      filePath: 'long.txt',
      project: 'p',
      language: 'text',
    });

    assert.ok(result.chunks.length >= 2, `expected >=2 chunks, got ${result.chunks.length}`);
    // First chunk starts at line 1; last chunk's end_line covers the last line.
    assert.equal(result.chunks[0]!.start_line, 1);
    assert.equal(result.chunks.at(-1)!.end_line, lines.length);

    // Adjacent chunks should overlap by ~4 lines per the spec.
    for (let i = 1; i < result.chunks.length; i++) {
      const prev = result.chunks[i - 1]!;
      const curr = result.chunks[i]!;
      const overlap = prev.end_line - curr.start_line + 1;
      assert.ok(overlap >= 1 && overlap <= 5, `unexpected overlap ${overlap} between chunk ${i - 1} and ${i}`);
    }
  });

  it('honors a custom startLine offset', () => {
    const result = chunkFallback('a\nb\n', {
      filePath: 'x.txt',
      project: 'p',
      language: 'text',
      startLine: 100,
    });
    assert.equal(result.chunks[0]!.start_line, 100);
  });

  it('attaches an explicit symbol when provided', () => {
    const result = chunkFallback('content\n', {
      filePath: 'x.ts',
      project: 'p',
      language: 'typescript',
      symbol: 'doThing',
    });
    assert.equal(result.chunks[0]!.symbol, 'doThing');
  });
});

describe('applyProjectPrefix', () => {
  it('prepends a project/file marker to embedded content but leaves raw_content untouched', () => {
    const base = chunkFallback('body\n', {
      filePath: 'a.ts',
      project: 'demo',
      language: 'typescript',
      symbol: 'foo',
    });
    const prefixed = applyProjectPrefix(base, 'demo');
    const chunk = prefixed.chunks[0]!;
    assert.match(chunk.content, /\[project:demo\]/);
    assert.match(chunk.content, /\[file:a\.ts\]/);
    assert.match(chunk.content, /\[symbol:foo\]/);
    // raw_content preserves the original lines including trailing newline.
    assert.equal(chunk.raw_content, 'body\n');
  });

  it('omits the symbol marker when the chunk has no symbol', () => {
    const base = chunkFallback('body\n', {
      filePath: 'a.txt',
      project: 'demo',
      language: 'text',
    });
    const prefixed = applyProjectPrefix(base, 'demo');
    assert.doesNotMatch(prefixed.chunks[0]!.content, /\[symbol:/);
  });
});
