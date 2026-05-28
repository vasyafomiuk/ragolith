// Schema migrations.
//
// `ensureSchema` only creates collections that don't exist yet — it has no
// way to evolve an existing schema. This module fills that gap.
//
// Pattern:
//   - Each migration has an integer `version` (monotonically increasing).
//   - We store the highest applied version in a one-row 'SchemaMeta'
//     collection — `{ id: 'ragolith', version: number }`.
//   - On run: list applied version, run every migration with a higher
//     version in order, persist the new max version after each.
//
// Migrations are intentionally small and explicit. Adding one means:
//   1. Add a new entry to MIGRATIONS with a fresh integer version.
//   2. Write its `up(client)` function — typically calls `collection.config.update`
//      to add a property, change tokenization, etc.
//   3. Bump CURRENT_SCHEMA_VERSION so a fresh `ensureSchema` also lands at
//      the right state for new installs.

import { dataType, generateUuid5, type WeaviateClient } from 'weaviate-client';
import { CODE_CHUNK } from './weaviate-client.js';

const META_COLLECTION = 'SchemaMeta';
// Weaviate requires object IDs to be UUIDs. Derive a stable one from a
// fixed seed so every run of every process targets the same row.
const META_ID = generateUuid5('ragolith-schema-version');

export interface Migration {
  version: number;
  description: string;
  up: (client: WeaviateClient) => Promise<void>;
}

/** Bump this when you add a migration so new schemas land at the same state. */
export const CURRENT_SCHEMA_VERSION = 1;

export const MIGRATIONS: Migration[] = [
  // Future migrations slot in here. Example shape:
  //
  // {
  //   version: 2,
  //   description: 'Add author_email to CodeChunk',
  //   up: async (client) => {
  //     const col = client.collections.get(CODE_CHUNK);
  //     await col.config.addProperty({ name: 'author_email', dataType: dataType.TEXT });
  //   },
  // },
];

async function ensureMetaCollection(client: WeaviateClient): Promise<void> {
  const existing = new Set((await client.collections.listAll()).map((c) => c.name));
  if (existing.has(META_COLLECTION)) return;
  await client.collections.create({
    name: META_COLLECTION,
    properties: [{ name: 'version', dataType: dataType.INT }],
  });
}

async function readVersion(client: WeaviateClient): Promise<number> {
  const col = client.collections.get(META_COLLECTION);
  try {
    const obj = await col.query.fetchObjectById(META_ID);
    if (!obj) return 0;
    const v = (obj.properties as Record<string, unknown>)['version'];
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

async function writeVersion(client: WeaviateClient, version: number): Promise<void> {
  const col = client.collections.get(META_COLLECTION);
  // upsert via insert/replace pattern: try update, fall back to insert.
  try {
    await col.data.update({ id: META_ID, properties: { version } });
  } catch {
    await col.data.insert({ id: META_ID, properties: { version } });
  }
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: { version: number; description: string }[];
}

/**
 * Run every migration whose version is greater than the currently applied one.
 * Idempotent: a second call from the same state is a no-op.
 */
export async function runMigrations(
  client: WeaviateClient,
  opts: { onlyToVersion?: number } = {},
): Promise<MigrationResult> {
  await ensureMetaCollection(client);
  const fromVersion = await readVersion(client);
  const target = opts.onlyToVersion ?? CURRENT_SCHEMA_VERSION;

  const pending = MIGRATIONS.filter((m) => m.version > fromVersion && m.version <= target).sort(
    (a, b) => a.version - b.version,
  );

  const applied: { version: number; description: string }[] = [];
  for (const mig of pending) {
    await mig.up(client);
    await writeVersion(client, mig.version);
    applied.push({ version: mig.version, description: mig.description });
  }

  // If there are no real migrations but the recorded version is behind the
  // CURRENT_SCHEMA_VERSION (e.g. an empty MIGRATIONS array but we want fresh
  // installs to skip ahead), bump the marker.
  if (applied.length === 0 && fromVersion < CURRENT_SCHEMA_VERSION) {
    await writeVersion(client, CURRENT_SCHEMA_VERSION);
  }

  const toVersion =
    applied.length > 0
      ? (applied.at(-1)?.version ?? fromVersion)
      : Math.max(fromVersion, CURRENT_SCHEMA_VERSION);
  return { fromVersion, toVersion, applied };
}

// We re-export CODE_CHUNK to make migration `up` functions read naturally
// without importing weaviate-client.ts separately.
export { CODE_CHUNK };
