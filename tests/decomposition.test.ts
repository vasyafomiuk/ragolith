import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  analyzeDecomposition,
  decomposeProject,
  moduleOf,
  resolveModuleCalls,
  type ModuleCall,
  type SymbolIndex,
} from '../src/core/analysis/decomposition.js';

describe('moduleOf', () => {
  it('strips container roots and takes the first segment', () => {
    assert.equal(moduleOf('src/auth/login.ts'), 'auth');
    assert.equal(moduleOf('lib/payments/charge.go'), 'payments');
    assert.equal(moduleOf('app/orders/index.js'), 'orders');
  });

  it('handles windows separators and ./ prefixes', () => {
    assert.equal(moduleOf('.\\src\\billing\\x.cs'), 'billing');
    assert.equal(moduleOf('./src/billing/y.cs'), 'billing');
  });

  it('returns (root) for a bare filename', () => {
    assert.equal(moduleOf('index.ts'), '(root)');
    assert.equal(moduleOf('src/main.ts'), '(root)'); // src stripped, only filename left
  });

  it('respects moduleDepth', () => {
    assert.equal(moduleOf('src/auth/oauth/login.ts', { moduleDepth: 2 }), 'auth/oauth');
  });

  it('byFile returns the whole normalized path (file-level graph)', () => {
    assert.equal(moduleOf('src/auth/login.ts', { byFile: true }), 'src/auth/login.ts');
    assert.equal(moduleOf('.\\src\\a.ts', { byFile: true }), 'src/a.ts');
  });

  it('keeps unstripped roots (monorepo packages)', () => {
    assert.equal(moduleOf('packages/api/src/x.ts'), 'packages');
    assert.equal(moduleOf('packages/api/src/x.ts', { moduleDepth: 2 }), 'packages/api');
  });
});

describe('resolveModuleCalls', () => {
  it('maps caller file + callee symbol to module→module calls', () => {
    const symbols: SymbolIndex = new Map([
      ['charge', new Set(['payments'])],
      ['sendEmail', new Set(['notifications'])],
    ]);
    const calls = resolveModuleCalls(
      [
        { file: 'src/orders/checkout.ts', callee: 'charge' },
        { file: 'src/orders/checkout.ts', callee: 'sendEmail' },
        { file: 'src/orders/checkout.ts', callee: 'unknownLib' }, // dropped
      ],
      symbols,
    );
    assert.deepEqual(calls, [
      { fromModule: 'orders', toModule: 'payments' },
      { fromModule: 'orders', toModule: 'notifications' },
    ]);
  });

  it('attributes ambiguous callees to every defining module', () => {
    const symbols: SymbolIndex = new Map([['save', new Set(['users', 'orders'])]]);
    const calls = resolveModuleCalls([{ file: 'src/api/handler.ts', callee: 'save' }], symbols);
    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(calls.map((c) => c.toModule)), new Set(['users', 'orders']));
  });
});

describe('analyzeDecomposition', () => {
  it('computes cohesion, instability, fan-in/out', () => {
    // orders calls payments twice (cross) and itself once (internal).
    const calls: ModuleCall[] = [
      { fromModule: 'orders', toModule: 'orders' },
      { fromModule: 'orders', toModule: 'payments' },
      { fromModule: 'orders', toModule: 'payments' },
      { fromModule: 'notifications', toModule: 'payments' },
    ];
    const report = analyzeDecomposition(
      'shop',
      { orders: 5, payments: 3, notifications: 2 },
      calls,
    );

    const orders = report.modules.find((m) => m.module === 'orders')!;
    assert.equal(orders.internalCalls, 1);
    assert.equal(orders.outboundCalls, 2);
    assert.equal(orders.fanOut, 1); // only payments
    assert.equal(orders.cohesion, round2(1 / 3));

    const payments = report.modules.find((m) => m.module === 'payments')!;
    assert.equal(payments.inboundCalls, 3);
    assert.equal(payments.fanIn, 2); // orders + notifications
    assert.equal(payments.fanOut, 0);
    assert.equal(payments.instability, 0); // stable — only depended upon
    assert.equal(payments.cohesion, 1); // no outbound, no internal → defined as 1

    assert.equal(report.totals.crossModuleCalls, 3);
  });

  it('ranks cross-module couplings by call volume', () => {
    const calls: ModuleCall[] = [
      { fromModule: 'a', toModule: 'b' },
      { fromModule: 'a', toModule: 'b' },
      { fromModule: 'b', toModule: 'a' }, // a<->b total 3
      { fromModule: 'a', toModule: 'c' }, // a<->c total 1
    ];
    const report = analyzeDecomposition('p', { a: 2, b: 2, c: 1 }, calls);
    assert.equal(report.couplings[0]?.calls, 3);
    assert.deepEqual([report.couplings[0]?.a, report.couplings[0]?.b], ['a', 'b']);
    assert.equal(report.couplings[1]?.calls, 1);
  });

  it('suggests cohesive, sufficiently-large modules as seams', () => {
    const calls: ModuleCall[] = [
      // billing is fully self-contained
      { fromModule: 'billing', toModule: 'billing' },
      { fromModule: 'billing', toModule: 'billing' },
      // glue is a coupling hub: all outbound
      { fromModule: 'glue', toModule: 'billing' },
      { fromModule: 'glue', toModule: 'reports' },
    ];
    const report = analyzeDecomposition('p', { billing: 4, reports: 3, glue: 2 }, calls, {
      cohesionThreshold: 0.6,
      minFilesForSeam: 2,
    });
    const seamModules = report.seams.map((s) => s.module);
    assert.ok(seamModules.includes('billing'), 'billing should be a seam');
    // glue has 0 internal / 2 outbound → cohesion 0 → not a seam
    assert.ok(!seamModules.includes('glue'), 'glue should not be a seam');
  });

  it('excludes (root) and tiny modules from seams', () => {
    const report = analyzeDecomposition('p', { '(root)': 9, tiny: 1 }, []);
    assert.equal(report.seams.length, 0);
  });

  it('labels a no-dependency module as a clean extraction candidate', () => {
    const report = analyzeDecomposition('p', { isolated: 3 }, [
      { fromModule: 'isolated', toModule: 'isolated' },
    ]);
    const seam = report.seams.find((s) => s.module === 'isolated');
    assert.ok(seam);
    assert.match(seam!.rationale, /self-contained/);
  });
});

describe('decomposeProject', () => {
  it('builds module counts + symbol index from raw inputs and analyzes', () => {
    const report = decomposeProject('shop', {
      files: [
        { file_path: 'src/orders/checkout.ts' },
        { file_path: 'src/orders/cart.ts' },
        { file_path: 'src/payments/charge.ts' },
      ],
      symbols: [
        { name: 'checkout', file_path: 'src/orders/checkout.ts' },
        { name: 'charge', file_path: 'src/payments/charge.ts' },
      ],
      edges: [
        { file: 'src/orders/checkout.ts', callee: 'charge' }, // orders → payments
        { file: 'src/orders/cart.ts', callee: 'checkout' }, // orders → orders (internal)
        { file: 'src/orders/checkout.ts', callee: 'thirdParty' }, // dropped (unknown)
      ],
    });

    assert.equal(report.project, 'shop');
    const orders = report.modules.find((m) => m.module === 'orders')!;
    assert.equal(orders.files, 2);
    assert.equal(orders.internalCalls, 1);
    assert.equal(orders.outboundCalls, 1);
    const payments = report.modules.find((m) => m.module === 'payments')!;
    assert.equal(payments.files, 1);
    assert.equal(payments.inboundCalls, 1);
    assert.equal(report.totals.crossModuleCalls, 1);
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
