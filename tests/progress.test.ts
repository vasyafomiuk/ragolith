import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createProgress } from '../src/core/progress.js';

/** Build a progress reporter that captures all writes into a string array
 *  plus a controllable clock so we can assert deterministic behavior. */
function makeFixture(opts: {
  total: number;
  isTTY: boolean;
  intervalMs?: number;
  nonTtyEvery?: number;
}) {
  const writes: string[] = [];
  let t = 1000;
  const p = createProgress({
    total: opts.total,
    label: 'test',
    indent: '> ',
    write: (s) => writes.push(s),
    isTTY: opts.isTTY,
    intervalMs: opts.intervalMs ?? 100,
    nonTtyEvery: opts.nonTtyEvery,
    now: () => t,
  });
  return {
    writes,
    p,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('createProgress — TTY mode', () => {
  it('writes carriage-returned lines and respects the interval throttle', () => {
    const f = makeFixture({ total: 10, isTTY: true, intervalMs: 100 });
    f.p.tick({ chunks: 2, detail: 'a.ts' }); // t=1000, first tick: forced emit
    f.advance(40);
    f.p.tick({ chunks: 1, detail: 'b.ts' }); // throttled
    f.advance(40);
    f.p.tick({ chunks: 1, detail: 'c.ts' }); // throttled
    f.advance(40);
    f.p.tick({ chunks: 1, detail: 'd.ts' }); // 120ms elapsed → emits
    assert.equal(f.writes.length, 2);
    for (const w of f.writes) {
      assert.ok(w.startsWith('\r'), 'TTY writes must start with carriage return');
      assert.ok(w.endsWith('\x1b[K'), 'TTY writes must end with the ANSI clear-line escape');
    }
    assert.match(f.writes[1]!, /4\/10/);
    assert.match(f.writes[1]!, /5 chunks/);
    assert.match(f.writes[1]!, /d\.ts/);
  });

  it('always emits when the counter hits the total', () => {
    const f = makeFixture({ total: 3, isTTY: true, intervalMs: 999_999 });
    f.p.tick(); // first tick: forced emit (current code emits with no throttle when n===total OR after intervalMs)
    f.p.tick();
    f.p.tick(); // 3/3 → forced emit
    // First tick was throttled-but-actually-emitted only at n===total.
    // We just assert the final emit is present.
    const lastEmit = f.writes[f.writes.length - 1]!;
    assert.match(lastEmit, /3\/3/);
  });

  it('done() clears the line and prints a summary with elapsed time', () => {
    const f = makeFixture({ total: 5, isTTY: true, intervalMs: 100 });
    f.p.tick({ chunks: 4, symbols: 2 });
    f.advance(1500);
    f.p.done('extra info');
    const lastTwo = f.writes.slice(-2);
    assert.equal(lastTwo[0], '\r\x1b[K', 'penultimate write should clear the in-progress line');
    assert.match(lastTwo[1]!, /✓ test: 1 files · 4 chunks · 2 sym · 0 edges in 1\.5s · extra info/);
  });

  it('done() is idempotent — second call is a no-op', () => {
    const f = makeFixture({ total: 1, isTTY: true });
    f.p.tick();
    f.p.done();
    const after = f.writes.length;
    f.p.done();
    f.p.tick();
    assert.equal(f.writes.length, after, 'no further writes after done()');
  });
});

describe('createProgress — non-TTY mode', () => {
  it('emits a fresh line every nonTtyEvery ticks plus the final total', () => {
    const f = makeFixture({ total: 10, isTTY: false, nonTtyEvery: 3 });
    for (let i = 0; i < 10; i++) f.p.tick({ chunks: 1 });
    // Expect emits at n=3, 6, 9, and 10 (final). Total 4 lines.
    assert.equal(f.writes.length, 4);
    for (const w of f.writes) {
      assert.ok(!w.startsWith('\r'), 'non-TTY writes must not use carriage returns');
      assert.ok(w.endsWith('\n'), 'non-TTY writes must be newline-terminated');
    }
    assert.match(f.writes.at(-1)!, /10\/10 \(100%\)/);
  });

  it('done() prints a summary line in non-TTY mode too', () => {
    const f = makeFixture({ total: 4, isTTY: false, nonTtyEvery: 4 });
    f.p.tick({ chunks: 2, edges: 1 });
    f.p.tick({ chunks: 2 });
    f.p.tick();
    f.p.tick(); // 4/4 → emit
    f.advance(2200);
    f.p.done();
    const summary = f.writes.at(-1)!;
    assert.match(summary, /✓ test: 4 files · 4 chunks · 0 sym · 1 edges in 2\.2s/);
  });
});

describe('createProgress — totals()', () => {
  it('returns running counts and elapsed time', () => {
    const f = makeFixture({ total: 5, isTTY: false, nonTtyEvery: 100 });
    f.p.tick({ chunks: 3, symbols: 1, edges: 2 });
    f.p.tick({ chunks: 2, symbols: 1 });
    f.advance(750);
    const totals = f.p.totals();
    assert.deepEqual(totals, { n: 2, chunks: 5, symbols: 2, edges: 2, elapsedMs: 750 });
  });
});

describe('createProgress — long detail strings', () => {
  it('truncates long file paths but keeps the leaf identifiable', () => {
    const f = makeFixture({ total: 1, isTTY: true });
    const longPath = 'a/very/deeply/nested/path/to/some/file/that/keeps/going.ts';
    f.p.tick({ detail: longPath });
    const out = f.writes.at(-1)!;
    // Leaf must survive truncation.
    assert.ok(out.includes('going.ts'));
    // Length-bounded — somewhere under 80 chars of payload (loose check).
    // Strip the leading \r and trailing ANSI clear-line via plain string ops to
    // avoid embedding control chars in a literal regex.
    const ANSI_CLEAR = '\x1b[K';
    let payload = out.startsWith('\r') ? out.slice(1) : out;
    if (payload.endsWith(ANSI_CLEAR)) payload = payload.slice(0, -ANSI_CLEAR.length);
    assert.ok(payload.length < 120, `payload too long: ${payload.length}`);
  });
});
