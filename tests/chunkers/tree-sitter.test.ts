// Tests that exercise tree-sitter-specific wins over the legacy regex chunker.
// Each case is something the regex implementation either gets wrong or misses:
// annotations attached to declarations, generic-heavy signatures, nested types,
// records / primary constructors, C# attributes and file-scoped namespaces.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkJava } from '../../src/core/chunkers/java-chunker.js';
import { chunkCSharp } from '../../src/core/chunkers/csharp-chunker.js';

describe('chunkJava — tree-sitter wins', () => {
  it('extracts methods on a class decorated with annotations', async () => {
    const src = `
package demo;

import org.springframework.stereotype.Service;

@Service
@Deprecated
public class UserService {
    @Override
    public String greet(String name) {
        return "hello " + name;
    }
}
`;
    const result = await chunkJava(src, { filePath: 'UserService.java', project: 'p' });
    const cls = result.symbols.find((s) => s.kind === 'class' && s.name === 'UserService');
    assert.ok(cls, 'expected the UserService class symbol');
    const m = result.symbols.find((s) => s.kind === 'method' && s.name === 'greet');
    assert.ok(m, 'expected the greet method symbol');
    assert.equal(m.parent, 'UserService');
  });

  it('handles generic method signatures', async () => {
    const src = `
public class Container {
    public <T extends Comparable<T>> Optional<T> findMax(List<T> items) {
        return items.stream().max(Comparable::compareTo);
    }
}
`;
    const result = await chunkJava(src, { filePath: 'Container.java', project: 'p' });
    const m = result.symbols.find((s) => s.kind === 'method' && s.name === 'findMax');
    assert.ok(m, 'expected findMax to be extracted despite the generic signature');
    assert.match(m.signature, /findMax/);
  });

  it('extracts nested classes with qualified symbol paths', async () => {
    const src = `
public class Outer {
    public static class Inner {
        public void hello() {}
    }
    public int outerMethod() { return 1; }
}
`;
    const result = await chunkJava(src, { filePath: 'Outer.java', project: 'p' });
    const outer = result.symbols.find((s) => s.kind === 'class' && s.name === 'Outer');
    const inner = result.symbols.find((s) => s.kind === 'class' && s.name === 'Inner');
    assert.ok(outer, 'expected Outer');
    assert.ok(inner, 'expected nested Inner');
    assert.equal(inner.parent, 'Outer');

    const helloChunk = result.chunks.find((c) => c.symbol === 'Outer.Inner.hello');
    assert.ok(helloChunk, 'expected Outer.Inner.hello chunk with fully-qualified symbol');
  });

  it('parses Java records', async () => {
    const src = `
public record User(String name, int age) {
    public String label() { return name + " (" + age + ")"; }
}
`;
    const result = await chunkJava(src, { filePath: 'User.java', project: 'p' });
    const rec = result.symbols.find((s) => s.name === 'User');
    assert.ok(rec, 'expected the User record symbol');
    // Records appear as `class` kind in our type system (close enough — they're
    // class-shaped from the index's perspective).
    assert.equal(rec.kind, 'class');
    assert.ok(result.symbols.some((s) => s.name === 'label' && s.parent === 'User'));
  });
});

describe('chunkCSharp — tree-sitter wins', () => {
  it('handles attribute-decorated classes', async () => {
    const src = `
using System;

namespace Demo;

[Serializable]
[Obsolete("use NewClass instead")]
public class OldClass
{
    public void DoStuff() { }
}
`;
    const result = await chunkCSharp(src, { filePath: 'OldClass.cs', project: 'p' });
    const cls = result.symbols.find((s) => s.kind === 'class' && s.name === 'OldClass');
    assert.ok(cls, 'expected the OldClass symbol despite the attributes');
    const m = result.symbols.find((s) => s.kind === 'method' && s.name === 'DoStuff');
    assert.ok(m);
    assert.equal(m.parent, 'Demo.OldClass');
  });

  it('extracts nested classes', async () => {
    const src = `
namespace Demo
{
    public class Outer
    {
        public class Inner
        {
            public void Hi() { }
        }
    }
}
`;
    const result = await chunkCSharp(src, { filePath: 'Outer.cs', project: 'p' });
    const inner = result.symbols.find((s) => s.kind === 'class' && s.name === 'Inner');
    assert.ok(inner);
    assert.equal(inner.parent, 'Demo.Outer');
    const hi = result.symbols.find((s) => s.kind === 'method' && s.name === 'Hi');
    assert.ok(hi);
    assert.equal(hi.parent, 'Demo.Outer.Inner');
  });

  it('parses C# records with primary constructors', async () => {
    const src = `
namespace Demo;

public record Point(int X, int Y)
{
    public double Length() => Math.Sqrt(X * X + Y * Y);
}
`;
    const result = await chunkCSharp(src, { filePath: 'Point.cs', project: 'p' });
    const rec = result.symbols.find((s) => s.name === 'Point');
    assert.ok(rec, 'expected the Point record');
    // Length is an expression-bodied method; the C# grammar still surfaces it
    // as a method_declaration.
    const len = result.symbols.find((s) => s.name === 'Length');
    assert.ok(len, 'expected Length method');
  });
});
