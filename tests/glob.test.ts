import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { matchesWildcard, toPathPattern, wildcardToRegExp } from '../src/core/glob.js';

describe('wildcardToRegExp / matchesWildcard', () => {
  it('matches * across any run of characters', () => {
    assert.ok(matchesWildcard('src/*', 'src/auth/login.ts'));
    assert.ok(matchesWildcard('*.controller.ts', 'user.controller.ts'));
    assert.ok(!matchesWildcard('*.controller.ts', 'user.service.ts'));
  });

  it('matches ? as a single character', () => {
    assert.ok(matchesWildcard('v?.ts', 'v1.ts'));
    assert.ok(!matchesWildcard('v?.ts', 'v10.ts'));
  });

  it('escapes regex metacharacters in literals', () => {
    assert.ok(matchesWildcard('a.b+c', 'a.b+c'));
    assert.ok(!matchesWildcard('a.b+c', 'aXbXc'));
  });

  it('is anchored (no partial matches)', () => {
    assert.ok(!matchesWildcard('auth', 'src/auth/login.ts'));
    assert.ok(matchesWildcard('*auth*', 'src/auth/login.ts'));
    assert.equal(wildcardToRegExp('x').source, '^x$');
  });
});

describe('toPathPattern', () => {
  it('wraps bare substrings in *…*', () => {
    assert.equal(toPathPattern('auth'), '*auth*');
    assert.ok(matchesWildcard(toPathPattern('auth'), 'src/auth/login.ts'));
  });

  it('leaves explicit wildcards untouched', () => {
    assert.equal(toPathPattern('src/*.ts'), 'src/*.ts');
    assert.equal(toPathPattern('v?.go'), 'v?.go');
  });

  it('normalizes backslashes', () => {
    assert.equal(toPathPattern('src\\auth'), '*src/auth*');
  });
});
