import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickChunker } from '../../src/core/chunkers/dispatch.js';

// Exercise the real dispatch path (csharp routes through tree-sitter + fallback).
const chunkCSharp = (content: string, opts: { filePath: string; project: string }) =>
  pickChunker({ ...opts, content, language: 'csharp' });

describe('chunkCSharp', () => {
  it('handles a block-scoped namespace with a class and method', async () => {
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
    const result = await chunkCSharp(src, { filePath: 'Greeter.cs', project: 'p' });

    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    const methodChunk = result.chunks.find((c) => c.chunk_type === 'method');
    assert.ok(classChunk);
    assert.ok(methodChunk);

    // Class chunk's symbol should carry the namespace prefix.
    assert.equal(classChunk!.symbol, 'Demo.Greeter');
    assert.equal(methodChunk!.symbol, 'Demo.Greeter.Greet');
  });

  it('handles a file-scoped namespace', async () => {
    const src = `
namespace Demo;

public class A
{
    public void Run() { }
}
`;
    const result = await chunkCSharp(src, { filePath: 'A.cs', project: 'p' });
    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    assert.ok(classChunk);
    assert.equal(classChunk!.symbol, 'Demo.A');
  });

  it('falls back to the line-based chunker when no type is found', async () => {
    const src = '// no namespace, no class\nusing System;\n';
    const result = await chunkCSharp(src, { filePath: 'x.cs', project: 'p' });
    assert.equal(result.symbols.length, 0);
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.chunks[0]!.chunk_type, 'fallback');
  });
});

describe('chunkCSharp — call edges', () => {
  it('extracts caller→callee edges from invocations', async () => {
    const src = `
namespace Shop
{
    public class Orders
    {
        public void Checkout(int total)
        {
            var p = new Payments();
            p.Charge(total);
            Notify();
        }
        private void Notify() { }
    }
}
`;
    const result = await chunkCSharp(src, { filePath: 'Orders.cs', project: 'p' });
    const callees = result.edges.map((e) => e.callee);
    // Member-access call (p.Charge) and bare call (Notify) both captured.
    assert.ok(callees.includes('Charge'), `expected Charge in ${JSON.stringify(callees)}`);
    assert.ok(callees.includes('Notify'), `expected Notify in ${JSON.stringify(callees)}`);

    const charge = result.edges.find((e) => e.callee === 'Charge');
    assert.equal(charge!.caller, 'Shop.Orders.Checkout');
    assert.equal(charge!.call_type, 'method'); // via receiver p.
    const notify = result.edges.find((e) => e.callee === 'Notify');
    assert.equal(notify!.call_type, 'static'); // bare call
  });

  it('emits no edges for a call-free class', async () => {
    const src = `
public class Plain { public int X => 1; }
`;
    const result = await chunkCSharp(src, { filePath: 'Plain.cs', project: 'p' });
    assert.equal(result.edges.length, 0);
  });
});
