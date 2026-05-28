import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkJava } from '../../src/core/chunkers/java-chunker.js';

describe('chunkJava', () => {
  it('extracts a class plus its methods', () => {
    const src = `
package demo;

public class Greeter {
    public String greet(String name) {
        return "hello " + name;
    }

    private static int counter() {
        return 42;
    }
}
`;
    const result = chunkJava(src, { filePath: 'Greeter.java', project: 'p' });

    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    const methodChunks = result.chunks.filter((c) => c.chunk_type === 'method');
    assert.ok(classChunk, 'expected one class chunk');
    assert.equal(methodChunks.length, 2);

    const classSym = result.symbols.find((s) => s.kind === 'class')!;
    assert.equal(classSym.name, 'Greeter');

    const greet = result.symbols.find((s) => s.kind === 'method' && s.name === 'greet')!;
    assert.equal(greet.parent, 'Greeter');
  });

  it('falls back to the line-based chunker when no class declaration is found', () => {
    const src = '// just a comment file, no class here\nint x;\n';
    const result = chunkJava(src, { filePath: 'note.java', project: 'p' });
    assert.equal(result.symbols.length, 0);
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.chunks[0]!.chunk_type, 'fallback');
  });
});
