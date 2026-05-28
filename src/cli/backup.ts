#!/usr/bin/env node
// Backup CLI — Weaviate backup/restore + optional S3 push/pull.
//
// Wraps Weaviate's built-in /v1/backups endpoints. With the filesystem backend
// the backup lives at $BACKUP_FILESYSTEM_PATH inside the container; we then
// optionally push that directory to S3 using the AWS CLI (no SDK dep here).

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { loadConfig } from '../core/config.js';

const program = new Command();
program
  .name('ragolith-backup')
  .description('Manage Weaviate backups (filesystem or S3 backend).');

interface BackupStatus {
  id: string;
  status: 'STARTED' | 'TRANSFERRING' | 'TRANSFERRED' | 'SUCCESS' | 'FAILED';
  error?: string;
  path?: string;
}

function baseUrl(): string {
  const cfg = loadConfig();
  const proto = cfg.weaviate.secure ? 'https' : 'http';
  return `${proto}://${cfg.weaviate.host}:${cfg.weaviate.httpPort}`;
}

async function pollStatus(id: string, backend: string, action: 'create' | 'restore'): Promise<void> {
  const url = `${baseUrl()}/v1/backups/${backend}/${id}/${action === 'restore' ? 'restore' : ''}`.replace(/\/$/, '');
  // Poll up to 30 minutes at 5s intervals.
  for (let i = 0; i < 360; i++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as BackupStatus;
    process.stderr.write(`[backup] ${body.status}${body.error ? ` — ${body.error}` : ''}\n`);
    if (body.status === 'SUCCESS') return;
    if (body.status === 'FAILED') throw new Error(body.error ?? 'backup failed');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('timed out waiting for backup to finish');
}

async function createBackup(id: string, backend: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/v1/backups/${backend}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`create failed (${res.status}): ${await res.text()}`);
  await pollStatus(id, backend, 'create');
}

async function restoreBackup(id: string, backend: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/v1/backups/${backend}/${id}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`restore failed (${res.status}): ${await res.text()}`);
  await pollStatus(id, backend, 'restore');
}

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', rejectP);
  });
}

async function s3Push(id: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.backup.s3?.bucket) throw new Error('backup.s3.bucket not configured');
  const prefix = cfg.backup.s3.prefix ?? '';
  // The filesystem path is bound to the container's /var/lib/weaviate-backups,
  // which docker-compose maps to the `weaviate_backups` named volume. We copy
  // out via `docker cp`, then sync to S3.
  const tmp = `./.ragolith/backup-${id}`;
  await runProcess('docker', ['cp', `ragolith-weaviate:/var/lib/weaviate-backups/${id}`, tmp]);
  await runProcess('aws', ['s3', 'sync', tmp, `s3://${cfg.backup.s3.bucket}/${prefix}${id}/`, '--region', cfg.backup.s3.region]);
}

async function s3Pull(id: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.backup.s3?.bucket) throw new Error('backup.s3.bucket not configured');
  const prefix = cfg.backup.s3.prefix ?? '';
  const tmp = `./.ragolith/backup-${id}`;
  await runProcess('aws', ['s3', 'sync', `s3://${cfg.backup.s3.bucket}/${prefix}${id}/`, tmp, '--region', cfg.backup.s3.region]);
  await runProcess('docker', ['cp', tmp, `ragolith-weaviate:/var/lib/weaviate-backups/${id}`]);
}

program
  .command('create <id>')
  .description('Create a backup with the given id')
  .option('--push-s3', 'After creating, push the backup to S3', false)
  .action(async (id: string, opts: { pushS3?: boolean }) => {
    const cfg = loadConfig();
    await createBackup(id, cfg.backup.backend);
    if (opts.pushS3) await s3Push(id);
    process.stderr.write(`[backup] create ${id} done\n`);
  });

program
  .command('restore <id>')
  .description('Restore the backup with the given id')
  .option('--pull-s3', 'Before restoring, pull the backup from S3', false)
  .action(async (id: string, opts: { pullS3?: boolean }) => {
    const cfg = loadConfig();
    if (opts.pullS3) await s3Pull(id);
    await restoreBackup(id, cfg.backup.backend);
    process.stderr.write(`[backup] restore ${id} done\n`);
  });

program
  .command('push <id>')
  .description('Push an existing local backup to S3')
  .action(async (id: string) => {
    await s3Push(id);
  });

program
  .command('pull <id>')
  .description('Pull a backup from S3 into the local Weaviate backups volume')
  .action(async (id: string) => {
    await s3Pull(id);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`[backup] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
