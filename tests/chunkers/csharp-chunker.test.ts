import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkCSharp } from '../../src/core/chunkers/csharp-chunker.js';

describe('chunkCSharp', () => {
  it('handles a block-scoped namespace with a class and method', () => {
    const src = `
namespace Demo
{
    public class Greeter
    {
        public string Greet(string name)
        {
            return "hello";
        }
    }
}
`;
    const result = chunkCSharp(src, { filePath: 'Greeter.cs', project: 'p' });

    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    const methodChunk = result.chunks.find((c) => c.chunk_type === 'method');
    assert.ok(classChunk);
    assert.ok(methodChunk);

    // Class chunk's symbol should carry the namespace prefix.
    assert.equal(classChunk!.symbol, 'Demo.Greeter');
    assert.equal(methodChunk!.symbol, 'Demo.Greeter.Greet');
  });

  it('handles a file-scoped namespace', () => {
    const src = `
namespace Demo;

public class A
{
    public void Run() { }
}
`;
    const result = chunkCSharp(src, { filePath: 'A.cs', project: 'p' });
    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    assert.ok(classChunk);
    assert.equal(classChunk!.symbol, 'Demo.A');
  });

  it('falls back to the line-based chunker when no type is found', () => {
    const src = '// no namespace, no class\nusing System;\n';
    const result = chunkCSharp(src, { filePath: 'x.cs', project: 'p' });
    assert.equal(result.symbols.length, 0);
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.chunks[0]!.chunk_type, 'fallback');
  });
});
