import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkAst } from '../../src/core/chunkers/ast-chunker.js';

describe('chunkAst (TS/JS)', () => {
  it('emits one chunk + symbol per top-level function', () => {
    const src = `
export function add(a: number, b: number): number {
  return a + b;
}

function internal() {
  return 1;
}
`;
    const result = chunkAst(src, {
      filePath: 'math.ts',
      project: 'p',
      language: 'typescript',
    });
    assert.equal(result.chunks.length, 2);
    assert.equal(result.symbols.length, 2);

    const add = result.symbols.find((s) => s.name === 'add')!;
    assert.equal(add.kind, 'function');
    assert.equal(add.exports, true);
    assert.match(add.signature, /add\(a: number, b: number\): number/);

    const internal = result.symbols.find((s) => s.name === 'internal')!;
    assert.equal(internal.exports, false);
  });

  it('emits a class chunk plus method chunks/symbols', () => {
    const src = `
export class Greeter {
  greet(name: string): string {
    return helper(name);
  }
  static make(): Greeter {
    return new Greeter();
  }
}
`;
    const result = chunkAst(src, {
      filePath: 'greeter.ts',
      project: 'p',
      language: 'typescript',
    });

    const classChunk = result.chunks.find((c) => c.chunk_type === 'class');
    const methodChunks = result.chunks.filter((c) => c.chunk_type === 'method');
    assert.ok(classChunk, 'expected one class chunk');
    assert.equal(methodChunks.length, 2);

    const classSym = result.symbols.find((s) => s.kind === 'class' && s.name === 'Greeter')!;
    assert.equal(classSym.exports, true);

    const greet = result.symbols.find((s) => s.kind === 'method' && s.name === 'greet')!;
    assert.equal(greet.parent, 'Greeter');
  });

  it('records call edges from a method body', () => {
    const src = `
export class A {
  run() {
    foo();
    this.bar();
  }
}
`;
    const result = chunkAst(src, {
      filePath: 'a.ts',
      project: 'p',
      language: 'typescript',
    });
    const calls = result.edges.map((e) => e.callee).sort();
    assert.deepEqual(calls, ['bar', 'foo']);
    for (const e of result.edges) {
      assert.equal(e.caller, 'A.run');
      assert.equal(e.project, 'p');
      assert.equal(e.file, 'a.ts');
    }
  });

  it('falls back to the line-based chunker when the file has no top-level structure', () => {
    const src = 'const x = 1; console.log(x);\n';
    const result = chunkAst(src, {
      filePath: 'script.ts',
      project: 'p',
      language: 'typescript',
    });
    // No symbols extracted; fallback emits chunk(s).
    assert.equal(result.symbols.length, 0);
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.chunks[0]!.chunk_type, 'fallback');
  });
});
