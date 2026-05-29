import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { simpleName, traceFlow, type FlowEdge } from '../src/core/analysis/callgraph.js';

describe('simpleName', () => {
  it('takes the last segment across separators', () => {
    assert.equal(simpleName('PaymentService.charge'), 'charge');
    assert.equal(simpleName('Acme::Billing::run'), 'run');
    assert.equal(simpleName('User#save'), 'save');
    assert.equal(simpleName('pkg/module/fn'), 'fn');
    assert.equal(simpleName('bare'), 'bare');
  });
});

describe('traceFlow', () => {
  // checkout → charge → capture ; charge → log ; cart → checkout
  const edges: FlowEdge[] = [
    { caller: 'OrderService.checkout', callee: 'charge', file: 'a.ts', line: 1 },
    { caller: 'PaymentService.charge', callee: 'capture', file: 'b.ts', line: 2 },
    { caller: 'PaymentService.charge', callee: 'log', file: 'b.ts', line: 3 },
    { caller: 'Cart.cart', callee: 'checkout', file: 'c.ts', line: 4 },
  ];

  it('traces callees downstream across hops', () => {
    const r = traceFlow(edges, 'checkout', { direction: 'callees', maxHops: 3 });
    assert.equal(r.center, 'checkout');
    assert.equal(r.hops[0]?.depth, 1);
    assert.deepEqual(
      r.hops[0]?.edges.map((e) => e.callee),
      ['charge'],
    );
    // depth 2 expands charge → capture, log
    const depth2 = r.hops.find((h) => h.depth === 2);
    assert.deepEqual(new Set(depth2?.edges.map((e) => e.callee)), new Set(['capture', 'log']));
    assert.ok(r.nodes.includes('capture') && r.nodes.includes('log'));
  });

  it('traces callers upstream', () => {
    const r = traceFlow(edges, 'charge', { direction: 'callers', maxHops: 3 });
    // charge is called by checkout; checkout is called by cart
    assert.deepEqual(
      r.hops[0]?.edges.map((e) => simpleName(e.caller)),
      ['checkout'],
    );
    const depth2 = r.hops.find((h) => h.depth === 2 && h.direction === 'callers');
    assert.deepEqual(
      depth2?.edges.map((e) => simpleName(e.caller)),
      ['cart'],
    );
  });

  it('respects maxHops', () => {
    const r = traceFlow(edges, 'checkout', { direction: 'callees', maxHops: 1 });
    assert.equal(r.hops.length, 1);
    assert.ok(!r.nodes.includes('capture'));
  });

  it('both directions are present and merged', () => {
    const r = traceFlow(edges, 'charge', { direction: 'both', maxHops: 2 });
    const dirs = new Set(r.hops.map((h) => h.direction));
    assert.ok(dirs.has('callees') && dirs.has('callers'));
  });

  it('terminates on cycles', () => {
    const cyclic: FlowEdge[] = [
      { caller: 'a', callee: 'b' },
      { caller: 'b', callee: 'a' },
    ];
    const r = traceFlow(cyclic, 'a', { direction: 'callees', maxHops: 10 });
    // a→b then b→a, then a already expanded → stop. 2 edges total.
    assert.equal(
      r.hops.reduce((n, h) => n + h.edges.length, 0),
      2,
    );
    assert.equal(r.truncated, false);
  });

  it('flags truncation when the edge cap is hit', () => {
    const many: FlowEdge[] = Array.from({ length: 10 }, (_, i) => ({
      caller: 'root',
      callee: `f${i}`,
    }));
    const r = traceFlow(many, 'root', { direction: 'callees', maxHops: 2, maxEdges: 3 });
    assert.equal(r.truncated, true);
    assert.ok(r.hops[0] && r.hops[0].edges.length <= 3);
  });

  it('returns just the center when nothing matches', () => {
    const r = traceFlow(edges, 'nonexistent', { direction: 'both' });
    assert.deepEqual(r.nodes, ['nonexistent']);
    assert.equal(r.hops.length, 0);
  });
});
