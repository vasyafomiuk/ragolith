import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { analyzeGaps, isCodeRef } from '../src/core/analysis/gaps.js';
import type { SdlcArtifact } from '../src/core/types.js';

function art(partial: Partial<SdlcArtifact> & { artifact_id: string }): SdlcArtifact {
  return {
    kind: 'requirement',
    title: partial.artifact_id,
    body: '',
    source: 'local',
    project: 'demo',
    links: [],
    tags: [],
    ...partial,
  };
}

describe('isCodeRef', () => {
  it('recognizes code-reference prefixes', () => {
    assert.equal(isCodeRef('repo:web/src/a.ts'), true);
    assert.equal(isCodeRef('symbol:web/Foo.bar'), true);
    assert.equal(isCodeRef('file:/abs/x'), true);
    assert.equal(isCodeRef('REQ-1'), false);
    assert.equal(isCodeRef('TC-9'), false);
  });
});

describe('analyzeGaps', () => {
  it('flags a requirement with no implementation link as high severity', () => {
    const r = analyzeGaps([art({ artifact_id: 'REQ-1', kind: 'requirement' })]);
    assert.equal(r.counts.unimplemented_requirement, 1);
    const g = r.gaps.find((x) => x.kind === 'unimplemented_requirement');
    assert.equal(g?.severity, 'high');
    assert.equal(g?.artifact_id, 'REQ-1');
  });

  it('treats an outgoing implemented_by (even to code) as implemented', () => {
    const r = analyzeGaps([
      art({
        artifact_id: 'REQ-1',
        links: [{ rel: 'implemented_by', target: 'repo:web/src/a.ts' }],
      }),
    ]);
    assert.equal(r.counts.unimplemented_requirement, 0);
    // implemented but untested → warning
    assert.equal(r.counts.untested_requirement, 1);
  });

  it('resolves implementation via an incoming implements link from code-or-artifact', () => {
    const r = analyzeGaps([
      art({ artifact_id: 'REQ-1', kind: 'requirement' }),
      art({
        artifact_id: 'MOD-1',
        kind: 'other',
        links: [{ rel: 'implements', target: 'REQ-1' }],
      }),
    ]);
    assert.equal(r.counts.unimplemented_requirement, 0);
    assert.equal(r.counts.untested_requirement, 1);
  });

  it('clears untested when a tested_by or incoming tests link exists', () => {
    const r = analyzeGaps([
      art({
        artifact_id: 'REQ-1',
        links: [
          { rel: 'implemented_by', target: 'repo:web/a.ts' },
          { rel: 'tested_by', target: 'TC-1' },
        ],
      }),
      art({ artifact_id: 'TC-1', kind: 'test_case', links: [{ rel: 'tests', target: 'REQ-1' }] }),
    ]);
    assert.equal(r.counts.unimplemented_requirement, 0);
    assert.equal(r.counts.untested_requirement, 0);
    assert.equal(r.counts.orphan_test, 0);
  });

  it('flags an accepted decision with no implementation link', () => {
    const r = analyzeGaps([
      art({ artifact_id: 'ADR-1', kind: 'decision', status: 'accepted' }),
      art({ artifact_id: 'ADR-2', kind: 'decision', status: 'proposed' }), // not accepted → ignored
    ]);
    assert.equal(r.counts.unimplemented_decision, 1);
    assert.equal(r.gaps.find((g) => g.kind === 'unimplemented_decision')?.artifact_id, 'ADR-1');
  });

  it('flags an orphan test case', () => {
    const r = analyzeGaps([art({ artifact_id: 'TC-9', kind: 'test_case' })]);
    assert.equal(r.counts.orphan_test, 1);
  });

  it('flags dangling links to unknown artifacts but not code refs', () => {
    const r = analyzeGaps([
      art({
        artifact_id: 'REQ-1',
        links: [
          { rel: 'depends_on', target: 'REQ-999' }, // unknown → dangling
          { rel: 'implemented_by', target: 'repo:web/a.ts' }, // code ref → fine
        ],
      }),
    ]);
    assert.equal(r.counts.dangling_link, 1);
    const g = r.gaps.find((x) => x.kind === 'dangling_link');
    assert.match(g!.detail, /REQ-999/);
  });

  it('produces totals and a kind breakdown', () => {
    const r = analyzeGaps([
      art({ artifact_id: 'REQ-1', kind: 'requirement' }),
      art({ artifact_id: 'TC-1', kind: 'test_case' }),
      art({ artifact_id: 'ADR-1', kind: 'decision', status: 'accepted' }),
    ]);
    assert.equal(r.totals.artifacts, 3);
    assert.equal(r.totals.byKind['requirement'], 1);
    assert.equal(r.totals.byKind['test_case'], 1);
    assert.equal(r.totals.byKind['decision'], 1);
  });

  it('sorts gaps by severity (high → warning → info)', () => {
    const r = analyzeGaps([
      art({ artifact_id: 'TC-9', kind: 'test_case' }), // orphan_test → info
      art({ artifact_id: 'REQ-1', kind: 'requirement' }), // unimplemented → high
    ]);
    assert.equal(r.gaps[0]?.severity, 'high');
    assert.equal(r.gaps[r.gaps.length - 1]?.severity, 'info');
  });

  it('honors custom requirement kinds', () => {
    const r = analyzeGaps([art({ artifact_id: 'T-1', kind: 'ticket' })], {
      requirementKinds: ['ticket'],
    });
    assert.equal(r.counts.unimplemented_requirement, 1);
  });
});
