import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { analyzeModernization, majorVersion } from '../src/core/analysis/modernization.js';
import type { DetectedFramework, TechStack } from '../src/core/types.js';

function stack(partial: Partial<TechStack>): TechStack {
  return {
    project: 'demo',
    languages: [],
    build_tools: [],
    runtimes: {},
    frameworks: [],
    manifests: [],
    detected_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

function fw(name: string, version: string): DetectedFramework {
  return { name, version, source: 'manifest' };
}

describe('majorVersion', () => {
  it('extracts the leading integer from loose version strings', () => {
    assert.equal(majorVersion('8'), 8);
    assert.equal(majorVersion('>=16'), 16);
    assert.equal(majorVersion('^4.2.1'), 4);
    assert.equal(majorVersion('17.0.1'), 17);
    assert.equal(majorVersion('2.7'), 2);
    assert.equal(majorVersion('none'), undefined);
  });
});

describe('analyzeModernization — runtimes', () => {
  it('flags legacy Java as high', () => {
    const r = analyzeModernization(stack({ runtimes: { java: '8' } }));
    assert.equal(r.counts.high, 1);
    assert.equal(r.findings[0]?.subject, 'java');
    assert.match(r.findings[0]!.recommendation, /Java 21/);
  });

  it('flags aging non-LTS Java as warning', () => {
    const r = analyzeModernization(stack({ runtimes: { java: '11' } }));
    assert.equal(r.counts.warning, 1);
  });

  it('passes a current LTS Java with no findings', () => {
    const r = analyzeModernization(stack({ runtimes: { java: '21' } }));
    assert.equal(r.findings.length, 0);
  });

  it('flags EOL Node as high and aging Node as warning', () => {
    assert.equal(analyzeModernization(stack({ runtimes: { node: '16' } })).counts.high, 1);
    assert.equal(analyzeModernization(stack({ runtimes: { nodejs: '18' } })).counts.warning, 1);
    assert.equal(analyzeModernization(stack({ runtimes: { node: '>=20' } })).findings.length, 0);
  });

  it('flags Python 2 as high and old 3.x as warning', () => {
    assert.equal(analyzeModernization(stack({ runtimes: { python: '2.7' } })).counts.high, 1);
    assert.equal(analyzeModernization(stack({ runtimes: { python: '3.7' } })).counts.warning, 1);
    assert.equal(analyzeModernization(stack({ runtimes: { python: '3.12' } })).findings.length, 0);
  });
});

describe('analyzeModernization — frameworks', () => {
  it('flags legacy Java EE javax.* as high', () => {
    const r = analyzeModernization(stack({ frameworks: [fw('Java EE (legacy javax.*)', 'n/a')] }));
    assert.equal(r.counts.high, 1);
    assert.match(r.findings[0]!.recommendation, /Jakarta EE/);
  });

  it('flags Spring Boot 2.x as warning and 1.x as high', () => {
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Spring Boot', '2.7.5')] })).counts.warning,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Spring Boot', '1.5.0')] })).counts.high,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Spring Boot', '3.2.0')] })).findings.length,
      0,
    );
  });

  it('flags old React and Vue 2', () => {
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('React', '16.14.0')] })).counts.warning,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Vue', '2.6.0')] })).counts.warning,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('React', '18.2.0')] })).findings.length,
      0,
    );
  });

  it('flags JUnit 4 as info', () => {
    const r = analyzeModernization(stack({ frameworks: [fw('JUnit 4', '4.13.2')] }));
    assert.equal(r.counts.info, 1);
  });

  it('combines runtime + framework findings and sorts by severity', () => {
    const r = analyzeModernization(
      stack({
        runtimes: { java: '8' }, // high
        frameworks: [fw('JUnit 4', '4.13'), fw('Spring Boot', '2.7')], // info + warning
      }),
    );
    assert.equal(r.findings.length, 3);
    assert.equal(r.findings[0]?.severity, 'high');
    assert.equal(r.findings[r.findings.length - 1]?.severity, 'info');
  });

  it('flags out-of-support .NET and ignores unknown runtimes', () => {
    assert.equal(analyzeModernization(stack({ runtimes: { dotnet: '5' } })).counts.warning, 1);
    assert.equal(analyzeModernization(stack({ runtimes: { dotnet: '8' } })).findings.length, 0);
    // unknown runtime key → no rule → no finding
    assert.equal(analyzeModernization(stack({ runtimes: { ruby: '2.5' } })).findings.length, 0);
  });

  it('flags AngularJS (1.x) as high and aging Angular as warning', () => {
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Angular', '1.8.3')] })).counts.high,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Angular', '12.0.0')] })).counts.warning,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Angular', '17.1.0')] })).findings.length,
      0,
    );
  });

  it('flags pre-4 Express as info', () => {
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Express', '3.21.2')] })).counts.info,
      1,
    );
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Express', '4.19.0')] })).findings.length,
      0,
    );
  });

  it('ignores frameworks with no matching rule', () => {
    assert.equal(
      analyzeModernization(stack({ frameworks: [fw('Prisma', '5.0.0')] })).findings.length,
      0,
    );
  });

  it('returns an empty report for a modern stack', () => {
    const r = analyzeModernization(
      stack({
        runtimes: { java: '21', node: '22' },
        frameworks: [fw('React', '19.0.0'), fw('Spring Boot', '3.3.0')],
      }),
    );
    assert.equal(r.findings.length, 0);
    assert.deepEqual(r.counts, { high: 0, warning: 0, info: 0 });
  });
});
