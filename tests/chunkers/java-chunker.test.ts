import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickChunker } from '../../src/core/chunkers/dispatch.js';

// Exercise the real dispatch path (java routes through tree-sitter + fallback).
const chunkJava = (content: string, opts: { filePath: string; project: string }) =>
  pickChunker({ ...opts, content, language: 'java' });

describe('chunkJava', () => {
  it('extracts a class plus its methods', async () => {
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
    const result = await chunkJava(src, { filePath: 'Greeter.java', project: 'p' });

    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    const methodChunks = result.chunks.filter((c) => c.chunk_type === 'method');
    assert.ok(classChunk, 'expected one class chunk');
    assert.equal(methodChunks.length, 2);

    const classSym = result.symbols.find((s) => s.kind === 'class')!;
    assert.equal(classSym.name, 'Greeter');

    const greet = result.symbols.find((s) => s.kind === 'method' && s.name === 'greet')!;
    assert.equal(greet.parent, 'Greeter');
  });

  it('falls back to the line-based chunker when no class declaration is found', async () => {
    const src = '// just a comment file, no class here\nint x;\n';
    const result = await chunkJava(src, { filePath: 'note.java', project: 'p' });
    assert.equal(result.symbols.length, 0);
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.chunks[0]!.chunk_type, 'fallback');
  });
});

describe('chunkJava — call edges', () => {
  it('extracts caller→callee edges from method invocations', async () => {
    const src = `
package shop;
public class Orders {
    private final Payments payments = new Payments();
    public void checkout(int total) {
        payments.charge(total);
        notifyUser();
    }
    private void notifyUser() {}
}
`;
    const result = await chunkJava(src, { filePath: 'Orders.java', project: 'p' });
    const callees = result.edges.map((e) => e.callee);
    assert.ok(callees.includes('charge'), `expected charge in ${JSON.stringify(callees)}`);
    assert.ok(callees.includes('notifyUser'), `expected notifyUser in ${JSON.stringify(callees)}`);
    const charge = result.edges.find((e) => e.callee === 'charge');
    assert.equal(charge!.call_type, 'method'); // payments.charge(...)
  });
});
