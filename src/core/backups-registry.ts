// Snapshot registry.
//
// Weaviate's filesystem-backup backend lives inside the container under a
// named Docker volume, and Weaviate (as of 1.24) doesn't expose a list-backups
// endpoint — `GET /v1/backups/{backend}` returns 501 "not implemented". So we
// keep our own ledger of snapshots created through ragolith and read from it
// in the dashboard.
//
// The file is co-located with the ingest state file (default
// `.ragolith/backups.json`). It's append/upsert by id, atomic writes via
// tmp + rename so concurrent writes from CLI + dashboard don't corrupt it.
//
// Snapshots created outside ragolith (e.g. by curling Weaviate's REST API
// directly) won't appear in the registry. That's an accepted cost — anyone
// using the raw API can `cat .ragolith/backups.json` and add an entry by
// hand if they want it tracked.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';

export interface SnapshotRecord {
  id: string;
  backend: string;
  /** ISO timestamp of when the create operation completed. */
  createdAt: string;
  status: 'success' | 'failed';
  /** Set true after a successful `s3Push` of the snapshot. */
  pushedToS3?: boolean;
}

export interface BackupRegistry {
  snapshots: SnapshotRecord[];
}

function registryPath(): string {
  const cfg = loadConfig();
  const stateDir = dirname(resolve(cfg.ingest.stateFile));
  return resolve(stateDir, 'backups.json');
}

export function loadRegistry(): BackupRegistry {
  const path = registryPath();
  if (!existsSync(path)) return { snapshots: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BackupRegistry;
    if (!parsed || !Array.isArray(parsed.snapshots)) return { snapshots: [] };
    return parsed;
  } catch {
    // Corrupt or partial JSON — treat as empty rather than crashing the CLI.
    return { snapshots: [] };
  }
}

async function saveRegistry(reg: BackupRegistry): Promise<void> {
  const path = registryPath();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
}

/** Insert or update a record by id. */
export async function recordSnapshot(rec: SnapshotRecord): Promise<void> {
  const reg = loadRegistry();
  const idx = reg.snapshots.findIndex((s) => s.id === rec.id);
  if (idx >= 0) reg.snapshots[idx] = { ...reg.snapshots[idx], ...rec };
  else reg.snapshots.push(rec);
  await saveRegistry(reg);
}

/** Mark an existing record as pushed to S3 (or add a stub if we don't have one). */
export async function markPushedToS3(id: string, backend: string): Promise<void> {
  const reg = loadRegistry();
  const rec = reg.snapshots.find((s) => s.id === id);
  if (rec) {
    rec.pushedToS3 = true;
  } else {
    // The user pushed an id we don't have a create-record for (e.g. it was
    // created via a previous ragolith install, or directly via Weaviate's
    // REST API). Add a minimal record so the snapshot at least shows up.
    reg.snapshots.push({
      id,
      backend,
      createdAt: new Date().toISOString(),
      status: 'success',
      pushedToS3: true,
    });
  }
  await saveRegistry(reg);
}
