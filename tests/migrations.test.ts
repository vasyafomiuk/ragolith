// Pure-logic tests for the migration runner.
//
// The runner against a real Weaviate is exercised by the integration suite.
// Here we test the static surface — the MIGRATIONS array shape, the
// CURRENT_SCHEMA_VERSION invariant, and the Migration interface contract.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, type Migration } from '../src/core/migrations.js';

describe('migrations registry', () => {
  it('has monotonically increasing version numbers', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      assert.ok(
        MIGRATIONS[i]!.version > MIGRATIONS[i - 1]!.version,
        `migration #${i} version ${MIGRATIONS[i]!.version} not > #${i - 1} version ${MIGRATIONS[i - 1]!.version}`,
      );
    }
  });

  it('every migration has a description + up function', () => {
    for (const m of MIGRATIONS) {
      assert.ok(typeof m.version === 'number');
      assert.ok(typeof m.description === 'string' && m.description.length > 0);
      assert.ok(typeof m.up === 'function');
    }
  });

  it('CURRENT_SCHEMA_VERSION is at least as high as the last migration', () => {
    const max = MIGRATIONS.length > 0 ? MIGRATIONS.at(-1)!.version : 0;
    assert.ok(
      CURRENT_SCHEMA_VERSION >= max,
      `CURRENT_SCHEMA_VERSION (${CURRENT_SCHEMA_VERSION}) must be >= last migration (${max})`,
    );
  });

  // Sanity-check the Migration type. If the interface ever changes, this
  // ensures the test file still compiles against it.
  it('Migration shape is statically typed', () => {
    const m: Migration = {
      version: 99,
      description: 'noop',
      up: async () => {},
    };
    assert.equal(m.version, 99);
  });
});
