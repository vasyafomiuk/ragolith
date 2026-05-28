import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickChunker } from '../src/core/chunkers/dispatch.js';

describe('pickChunker', () => {
  it('uses the AST chunker for TypeScript', async () => {
    const result = await pickChunker({
      content: 'export function f() { return 1; }\n',
      filePath: 'a.ts',
      project: 'p',
      language: 'typescript',
    });
    // AST chunker emits function-level chunks/symbols; fallback would emit chunk_type=fallback.
    assert.ok(result.symbols.some((s) => s.name === 'f' && s.kind === 'function'));
  });

  it('uses the AST chunker for JavaScript', async () => {
    const result = await pickChunker({
      content: 'function g() { return 2; }\n',
      filePath: 'a.js',
      project: 'p',
      language: 'javascript',
    });
    assert.ok(result.symbols.some((s) => s.name === 'g'));
  });

  it('uses the Java chunker for Java', async () => {
    const src = 'public class C { public int m() { return 1; } }\n';
    const result = await pickChunker({
      content: src,
      filePath: 'C.java',
      project: 'p',
      language: 'java',
    });
    assert.ok(result.symbols.some((s) => s.name === 'C' && s.kind === 'class'));
  });

  it('uses the C# chunker for C#', async () => {
    const src = 'namespace N { public class C { public void M() {} } }\n';
    const result = await pickChunker({
      content: src,
      filePath: 'C.cs',
      project: 'p',
      language: 'csharp',
    });
    assert.ok(result.chunks.some((c) => c.chunk_type === 'class'));
  });

  it('uses the SQL chunker for SQL', async () => {
    const result = await pickChunker({
      content: 'SELECT 1; SELECT 2;',
      filePath: 'q.sql',
      project: 'p',
      language: 'sql',
    });
    assert.ok(result.chunks.every((c) => c.chunk_type === 'statement'));
    assert.equal(result.chunks.length, 2);
  });

  it('falls back to the line-based chunker for unknown languages', async () => {
    const result = await pickChunker({
      content: 'arbitrary text\n',
      filePath: 'x.unknown',
      project: 'p',
      language: 'unknown',
    });
    assert.equal(result.chunks[0]!.chunk_type, 'fallback');
  });
});
