// Tree-sitter chunker coverage for the secondary languages.
// One or two probe tests per language — enough to confirm the grammar
// loads, the walker emits sensible symbols, and the dispatch wires the
// language code to the right grammar.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickChunker } from '../../src/core/chunkers/dispatch.js';

describe('pickChunker — Python', () => {
  it('extracts a class with methods', async () => {
    const src = `
class Greeter:
    def greet(self, name):
        return f"hello {name}"

    def _internal(self):
        return 1
`;
    const r = await pickChunker({
      content: src,
      filePath: 'g.py',
      project: 'p',
      language: 'python',
    });
    assert.ok(r.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class'));
    const greet = r.symbols.find((s) => s.name === 'greet');
    assert.ok(greet, 'expected greet method');
    assert.equal(greet.parent, 'Greeter');
    // Python convention: leading underscore = non-exported.
    const internal = r.symbols.find((s) => s.name === '_internal');
    assert.ok(internal);
    assert.equal(internal.exports, false);
  });

  it('extracts a top-level function as a function (not a method)', async () => {
    const r = await pickChunker({
      content: 'def parse_date(s):\n    return s\n',
      filePath: 'u.py',
      project: 'p',
      language: 'python',
    });
    const fn = r.symbols.find((s) => s.name === 'parse_date');
    assert.ok(fn);
    assert.equal(fn.kind, 'function');
    assert.equal(fn.parent, undefined);
  });
});

describe('pickChunker — Go', () => {
  it('extracts struct types and methods', async () => {
    const src = `
package main

type Greeter struct {
    Name string
}

func (g *Greeter) Greet() string {
    return "hello " + g.Name
}

func NewGreeter(name string) *Greeter {
    return &Greeter{Name: name}
}
`;
    const r = await pickChunker({ content: src, filePath: 'g.go', project: 'p', language: 'go' });
    assert.ok(r.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class'));
    assert.ok(r.symbols.some((s) => s.name === 'NewGreeter' && s.kind === 'function'));
    const greet = r.symbols.find((s) => s.name === 'Greet');
    assert.ok(greet, 'expected Greet method');
    // Go method_declaration has no parent container in the AST (the receiver
    // is a separate field) — surface as method kind via the methods set.
    assert.equal(greet.kind, 'method');
    // Uppercase first letter → exported in Go.
    assert.equal(greet.exports, true);
  });
});

describe('pickChunker — Rust', () => {
  it('extracts struct + impl block methods', async () => {
    const src = `
pub struct Greeter {
    pub name: String,
}

impl Greeter {
    pub fn greet(&self) -> String {
        format!("hello {}", self.name)
    }
}

pub fn make_greeter(name: String) -> Greeter {
    Greeter { name }
}
`;
    const r = await pickChunker({ content: src, filePath: 'g.rs', project: 'p', language: 'rust' });
    assert.ok(r.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class'));
    const greet = r.symbols.find((s) => s.name === 'greet');
    assert.ok(greet, 'expected greet fn extracted from impl block');
    // Inside impl Greeter, parent should be 'Greeter'.
    assert.equal(greet.parent, 'Greeter');
    // Top-level function.
    assert.ok(r.symbols.some((s) => s.name === 'make_greeter' && s.kind === 'function'));
  });

  it('extracts traits with the interface kind', async () => {
    const src = `
pub trait Sayable {
    fn say(&self) -> String;
}
`;
    const r = await pickChunker({ content: src, filePath: 't.rs', project: 'p', language: 'rust' });
    const trait = r.symbols.find((s) => s.name === 'Sayable');
    assert.ok(trait);
    assert.equal(trait.kind, 'interface');
  });
});

describe('pickChunker — Ruby', () => {
  it('extracts a class with methods', async () => {
    const src = `
class Greeter
  def greet(name)
    "hello #{name}"
  end
end
`;
    const r = await pickChunker({ content: src, filePath: 'g.rb', project: 'p', language: 'ruby' });
    assert.ok(r.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class'));
    const greet = r.symbols.find((s) => s.name === 'greet');
    assert.ok(greet);
    assert.equal(greet.parent, 'Greeter');
  });

  it('treats module declarations as namespaces', async () => {
    const src = `
module Demo
  class Inner
    def hi; end
  end
end
`;
    const r = await pickChunker({ content: src, filePath: 'm.rb', project: 'p', language: 'ruby' });
    const demo = r.symbols.find((s) => s.name === 'Demo');
    assert.ok(demo);
    assert.equal(demo.kind, 'namespace');
    const inner = r.symbols.find((s) => s.name === 'Inner');
    assert.ok(inner);
    assert.equal(inner.parent, 'Demo');
  });
});

describe('pickChunker — PHP', () => {
  it('extracts class + methods inside a namespace', async () => {
    const src = `<?php
namespace Demo;

class Greeter {
    public function greet(string $name): string {
        return "hello " . $name;
    }
}
`;
    const r = await pickChunker({ content: src, filePath: 'g.php', project: 'p', language: 'php' });
    assert.ok(r.symbols.some((s) => s.name === 'Demo' && s.kind === 'namespace'));
    const cls = r.symbols.find((s) => s.name === 'Greeter');
    assert.ok(cls);
    assert.equal(cls.parent, 'Demo');
    const greet = r.symbols.find((s) => s.name === 'greet');
    assert.ok(greet);
    assert.equal(greet.parent, 'Demo.Greeter');
  });
});

describe('call edges — all tree-sitter languages', () => {
  const cases = [
    {
      lang: 'python',
      file: 'a.py',
      src: 'class O:\n    def place(self, total):\n        self.pay.charge(total)\n        notify("u")\n',
    },
    {
      lang: 'go',
      file: 'a.go',
      src: 'func place(total int) {\n\tpay.charge(total)\n\tnotify("u")\n}',
    },
    {
      lang: 'rust',
      file: 'a.rs',
      src: 'fn place(total: i32) {\n    pay.charge(total);\n    notify("u");\n}',
    },
    {
      lang: 'ruby',
      file: 'a.rb',
      src: 'def place(total)\n  pay.charge(total)\n  notify("u")\nend',
    },
    {
      lang: 'php',
      file: 'a.php',
      src: '<?php\nfunction place($total) {\n  $pay->charge($total);\n  notify("u");\n}',
    },
  ];

  for (const c of cases) {
    it(`${c.lang}: emits caller→callee edges (member + bare)`, async () => {
      const r = await pickChunker({
        content: c.src,
        filePath: c.file,
        project: 'p',
        language: c.lang as never,
      });
      const callees = r.edges.map((e) => e.callee);
      assert.ok(
        callees.includes('charge'),
        `${c.lang}: expected charge in ${JSON.stringify(callees)}`,
      );
      assert.ok(
        callees.includes('notify'),
        `${c.lang}: expected notify in ${JSON.stringify(callees)}`,
      );
      assert.equal(
        r.edges.find((e) => e.callee === 'charge')!.call_type,
        'method',
        `${c.lang}: charge should be a member call`,
      );
    });
  }
});
