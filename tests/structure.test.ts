import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildProjectStructure, dirOf, type FileEntry } from '../src/core/structure.js';

describe('dirOf', () => {
  it('returns the directory or (root)', () => {
    assert.equal(dirOf('src/auth/login.ts'), 'src/auth');
    assert.equal(dirOf('index.ts'), '(root)');
  });
});

describe('buildProjectStructure', () => {
  it('groups files by directory with counts', () => {
    const files: FileEntry[] = [
      { file_path: 'src/auth/login.ts', language: 'typescript' },
      { file_path: 'src/auth/token.ts', language: 'typescript' },
      { file_path: 'src/db/conn.go', language: 'go' },
      { file_path: 'README.md', language: 'markdown' },
    ];
    const s = buildProjectStructure(files);
    assert.equal(s.totalFiles, 4);
    assert.deepEqual(s.languages, { typescript: 2, go: 1, markdown: 1 });

    const auth = s.directories.find((d) => d.dir === 'src/auth');
    assert.equal(auth?.files, 2);
    assert.deepEqual(auth?.languages, { typescript: 2 });
    assert.deepEqual(auth?.paths, ['src/auth/login.ts', 'src/auth/token.ts']);

    const root = s.directories.find((d) => d.dir === '(root)');
    assert.equal(root?.files, 1);
  });

  it('dedupes repeated chunks of the same file', () => {
    const files: FileEntry[] = [
      { file_path: 'src/a.ts', language: 'typescript', project: 'p' },
      { file_path: 'src/a.ts', language: 'typescript', project: 'p' },
      { file_path: 'src/a.ts', language: 'typescript', project: 'p' },
    ];
    assert.equal(buildProjectStructure(files).totalFiles, 1);
  });

  it('keeps same path under different projects distinct', () => {
    const files: FileEntry[] = [
      { file_path: 'src/a.ts', project: 'p1', language: 'typescript' },
      { file_path: 'src/a.ts', project: 'p2', language: 'typescript' },
    ];
    assert.equal(buildProjectStructure(files).totalFiles, 2);
  });

  it('normalizes windows separators and ./ prefixes', () => {
    const files: FileEntry[] = [{ file_path: '.\\src\\auth\\x.cs', language: 'csharp' }];
    const s = buildProjectStructure(files);
    assert.equal(s.directories[0]?.dir, 'src/auth');
  });

  it('labels missing language as unknown and sorts directories', () => {
    const s = buildProjectStructure([
      { file_path: 'z/last.ts' },
      { file_path: 'a/first.ts', language: 'typescript' },
    ]);
    assert.equal(s.directories[0]?.dir, 'a');
    assert.equal(s.languages['unknown'], 1);
  });
});
