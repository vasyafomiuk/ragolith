import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  artifactContent,
  coerceKind,
  isRsifFile,
  normalizeArtifact,
  parseFrontmatter,
  parseJsonArray,
  parseMarkdownArtifact,
  parseNdjson,
  parseRsifFile,
  splitFrontmatter,
  type ArtifactDefaults,
} from '../src/core/sdlc.js';

const DEF: ArtifactDefaults = { source: 'local', project: 'demo' };

describe('coerceKind', () => {
  it('keeps canonical kinds', () => {
    assert.equal(coerceKind('requirement'), 'requirement');
    assert.equal(coerceKind('decision'), 'decision');
    assert.equal(coerceKind('test_case'), 'test_case');
  });

  it('folds aliases', () => {
    assert.equal(coerceKind('ADR'), 'decision');
    assert.equal(coerceKind('user story'), 'story');
    assert.equal(coerceKind('bug'), 'ticket');
    assert.equal(coerceKind('openapi'), 'api_spec');
    assert.equal(coerceKind('postmortem'), 'incident');
  });

  it('maps unknown / missing to other', () => {
    assert.equal(coerceKind('banana'), 'other');
    assert.equal(coerceKind(undefined), 'other');
    assert.equal(coerceKind(42), 'other');
  });
});

describe('splitFrontmatter', () => {
  it('extracts a leading --- fence', () => {
    const { raw, body } = splitFrontmatter('---\nid: A\n---\nhello\nworld\n');
    assert.equal(raw, 'id: A');
    assert.equal(body, 'hello\nworld\n');
  });

  it('returns no frontmatter when there is no fence', () => {
    const { raw, body } = splitFrontmatter('# Just a doc\ntext');
    assert.equal(raw, undefined);
    assert.equal(body, '# Just a doc\ntext');
  });

  it('handles CRLF', () => {
    const { raw, body } = splitFrontmatter('---\r\nid: A\r\n---\r\nbody\r\n');
    assert.equal(raw, 'id: A');
    assert.equal(body.trim(), 'body');
  });
});

describe('parseFrontmatter', () => {
  it('parses scalars with type coercion', () => {
    const d = parseFrontmatter('id: PROJ-1\ncount: 3\ndone: true\nquoted: "a: b"');
    assert.equal(d['id'], 'PROJ-1');
    assert.equal(d['count'], 3);
    assert.equal(d['done'], true);
    assert.equal(d['quoted'], 'a: b');
  });

  it('parses flow sequences', () => {
    const d = parseFrontmatter('tags: [auth, security, "two words"]');
    assert.deepEqual(d['tags'], ['auth', 'security', 'two words']);
  });

  it('parses block sequences of scalars', () => {
    const d = parseFrontmatter('tags:\n  - auth\n  - security\n');
    assert.deepEqual(d['tags'], ['auth', 'security']);
  });

  it('parses block sequences of maps (links)', () => {
    const raw = [
      'links:',
      '  - rel: implemented_by',
      '    target: repo:web/src/a.ts',
      '  - rel: tested_by',
      '    target: TC-1',
    ].join('\n');
    const d = parseFrontmatter(raw);
    assert.deepEqual(d['links'], [
      { rel: 'implemented_by', target: 'repo:web/src/a.ts' },
      { rel: 'tested_by', target: 'TC-1' },
    ]);
  });

  it('ignores comments and blank lines', () => {
    const d = parseFrontmatter('# a comment\n\nid: X\n# trailing\n');
    assert.equal(d['id'], 'X');
    assert.equal(Object.keys(d).length, 1);
  });
});

describe('normalizeArtifact', () => {
  it('requires artifact_id and title', () => {
    assert.ok('error' in normalizeArtifact({ title: 'x' }, DEF));
    assert.ok('error' in normalizeArtifact({ id: 'X' }, DEF));
  });

  it('applies field aliases and defaults', () => {
    const res = normalizeArtifact(
      { id: 'PROJ-1', summary: 'Login', description: 'body text', type: 'bug' },
      DEF,
    );
    assert.ok('artifact' in res);
    if ('artifact' in res) {
      const a = res.artifact;
      assert.equal(a.artifact_id, 'PROJ-1');
      assert.equal(a.title, 'Login');
      assert.equal(a.body, 'body text');
      assert.equal(a.kind, 'ticket');
      assert.equal(a.source, 'local');
      assert.equal(a.project, 'demo');
    }
  });

  it('lets explicit source/project override defaults', () => {
    const res = normalizeArtifact(
      { id: 'A', title: 'T', source: 'jira', project: 'payments' },
      DEF,
    );
    if ('artifact' in res) {
      assert.equal(res.artifact.source, 'jira');
      assert.equal(res.artifact.project, 'payments');
    }
  });

  it('normalizes links and drops invalid rels', () => {
    const res = normalizeArtifact(
      {
        id: 'A',
        title: 'T',
        links: [
          { rel: 'implemented_by', target: 'repo:x' },
          { rel: 'nonsense', target: 'y' },
          { rel: 'tests', to: 'TC-9' },
          { target: 'no-rel' },
        ],
      },
      DEF,
    );
    if ('artifact' in res) {
      assert.deepEqual(res.artifact.links, [
        { rel: 'implemented_by', target: 'repo:x' },
        { rel: 'tests', target: 'TC-9' },
      ]);
    }
  });

  it('splits a comma-separated tags scalar', () => {
    const res = normalizeArtifact({ id: 'A', title: 'T', tags: 'auth, security' }, DEF);
    if ('artifact' in res) assert.deepEqual(res.artifact.tags, ['auth', 'security']);
  });
});

describe('parseNdjson', () => {
  it('parses one object per line and skips blanks', () => {
    const text = [
      '{"id":"A","title":"Alpha"}',
      '',
      '{"id":"B","title":"Beta","kind":"decision"}',
    ].join('\n');
    const { artifacts, warnings } = parseNdjson(text, DEF);
    assert.equal(artifacts.length, 2);
    assert.equal(warnings.length, 0);
    assert.equal(artifacts[1]!.kind, 'decision');
  });

  it('warns on bad JSON and missing fields but keeps going', () => {
    const text = ['{not json}', '{"id":"A"}', '{"id":"B","title":"Beta"}'].join('\n');
    const { artifacts, warnings } = parseNdjson(text, DEF);
    assert.equal(artifacts.length, 1);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /line 1/);
    assert.match(warnings[1]!, /line 2/);
  });
});

describe('parseJsonArray', () => {
  it('parses an array of artifacts', () => {
    const { artifacts } = parseJsonArray(
      '[{"id":"A","title":"Alpha"},{"id":"B","title":"Beta"}]',
      DEF,
    );
    assert.equal(artifacts.length, 2);
  });

  it('accepts a single object too', () => {
    const { artifacts } = parseJsonArray('{"id":"A","title":"Alpha"}', DEF);
    assert.equal(artifacts.length, 1);
  });
});

describe('parseMarkdownArtifact', () => {
  it('combines frontmatter metadata with the markdown body', () => {
    const text = [
      '---',
      'id: REQ-1',
      'kind: requirement',
      'title: Reset password',
      'tags: [auth]',
      'links:',
      '  - rel: implemented_by',
      '    target: repo:web/src/reset.ts',
      '---',
      'As a user I want to reset my password.',
    ].join('\n');
    const { artifacts } = parseMarkdownArtifact(text, DEF);
    assert.equal(artifacts.length, 1);
    const a = artifacts[0]!;
    assert.equal(a.artifact_id, 'REQ-1');
    assert.equal(a.kind, 'requirement');
    assert.equal(a.title, 'Reset password');
    assert.deepEqual(a.tags, ['auth']);
    assert.equal(a.links.length, 1);
    assert.match(a.body, /reset my password/);
  });

  it('falls back to filename id and first heading title without frontmatter', () => {
    const text = '# Big Decision\n\nWe chose Postgres.';
    const { artifacts } = parseMarkdownArtifact(text, DEF, {
      fallbackId: 'adr-0001',
      fallbackTitle: 'adr-0001',
    });
    assert.equal(artifacts[0]!.artifact_id, 'adr-0001');
    assert.equal(artifacts[0]!.title, 'Big Decision');
  });
});

describe('parseRsifFile', () => {
  it('dispatches by extension', () => {
    const nd = parseRsifFile('x.ndjson', '{"id":"A","title":"T"}', DEF);
    assert.equal(nd.artifacts.length, 1);

    const md = parseRsifFile('decisions/adr-7.md', '# Use gRPC\n\nbody', DEF);
    assert.equal(md.artifacts.length, 1);
    assert.equal(md.artifacts[0]!.artifact_id, 'adr-7');
    assert.equal(md.artifacts[0]!.title, 'Use gRPC');

    const j = parseRsifFile('x.json', '[{"id":"A","title":"T"}]', DEF);
    assert.equal(j.artifacts.length, 1);
  });

  it('warns on unrecognized extensions', () => {
    const r = parseRsifFile('notes.txt', 'whatever', DEF);
    assert.equal(r.artifacts.length, 0);
    assert.equal(r.warnings.length, 1);
  });
});

describe('isRsifFile', () => {
  it('recognizes md / ndjson / jsonl / json', () => {
    assert.equal(isRsifFile('a.md'), true);
    assert.equal(isRsifFile('a.markdown'), true);
    assert.equal(isRsifFile('a.ndjson'), true);
    assert.equal(isRsifFile('a.jsonl'), true);
    assert.equal(isRsifFile('a.json'), true);
    assert.equal(isRsifFile('a.txt'), false);
    assert.equal(isRsifFile('a.pdf'), false);
  });
});

describe('artifactContent', () => {
  it('builds a context-prefixed embed string', () => {
    const content = artifactContent({
      artifact_id: 'REQ-1',
      kind: 'requirement',
      title: 'Reset password',
      body: 'detail',
      source: 'local',
      project: 'demo',
      links: [],
      tags: [],
    });
    assert.match(content, /\[requirement\]/);
    assert.match(content, /\[project:demo\]/);
    assert.match(content, /\[id:REQ-1\]/);
    assert.match(content, /Reset password/);
    assert.match(content, /detail/);
  });
});
