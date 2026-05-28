import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLanguage, readSourceFile } from '../src/core/file-reader.js';

describe('detectLanguage', () => {
  it('maps common extensions to their language', () => {
    assert.equal(detectLanguage('foo.ts'), 'typescript');
    assert.equal(detectLanguage('foo.tsx'), 'typescript');
    assert.equal(detectLanguage('foo.js'), 'javascript');
    assert.equal(detectLanguage('Bar.java'), 'java');
    assert.equal(detectLanguage('Bar.cs'), 'csharp');
    assert.equal(detectLanguage('q.sql'), 'sql');
    assert.equal(detectLanguage('README.md'), 'markdown');
    assert.equal(detectLanguage('spec.pdf'), 'pdf');
    assert.equal(detectLanguage('notes.docx'), 'docx');
  });

  it('falls back to unknown for unrecognized extensions', () => {
    assert.equal(detectLanguage('mystery.xyz'), 'unknown');
  });

  it('is case-insensitive on the extension', () => {
    assert.equal(detectLanguage('Foo.TS'), 'typescript');
  });
});

describe('readSourceFile', () => {
  it('reads a UTF-8 text file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ragolith-read-'));
    try {
      const path = join(dir, 'sample.ts');
      await writeFile(path, 'export const x = 1;\n');
      const result = await readSourceFile(path, 1_048_576);
      assert.ok(result);
      assert.equal(result!.language, 'typescript');
      assert.match(result!.content, /export const x/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for files that look binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ragolith-read-'));
    try {
      const path = join(dir, 'binary.bin');
      const buf = Buffer.alloc(1024);
      buf[10] = 0; // NUL byte in the first 8KB triggers the binary heuristic
      buf[0] = 0x7f;
      await writeFile(path, buf);
      const result = await readSourceFile(path, 1_048_576);
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for files larger than the byte limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ragolith-read-'));
    try {
      const path = join(dir, 'big.txt');
      await writeFile(path, 'x'.repeat(2048));
      const result = await readSourceFile(path, 1024);
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
