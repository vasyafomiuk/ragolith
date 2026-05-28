// Thin wrapper over simple-git for the ingest pipeline.
//
// - Tokens are injected into the clone URL via the env var named in `project.tokenEnv`
//   (default: `GIT_TOKEN`). They are never persisted in the working copy's remote config.
// - Push is intentionally not exposed — this layer is read-only by design.

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { ProjectConfig } from './types.js';

export interface RepoHandle {
  /** Absolute path to the local working tree. */
  path: string;
  /** Current HEAD commit after sync. */
  head: string;
}

/** Inject a token into a clone URL. Supports HTTPS GitHub/GitLab style URLs. */
function withToken(url: string, token: string | undefined): string {
  if (!token) return url;
  // Already has credentials → leave it alone.
  if (/^https?:\/\/[^@/]+@/.test(url)) return url;
  return url.replace(/^https?:\/\//, (m) => `${m}x-access-token:${token}@`);
}

/** Resolve the working directory for a project under `workDir`. */
export function repoDir(workDir: string, project: ProjectConfig): string {
  if (project.localPath) return resolve(project.localPath);
  return resolve(workDir, project.name);
}

/**
 * Ensure a project's working tree exists and is on the requested branch at HEAD.
 * - If `localPath` is set, no clone happens; the local tree is used as-is.
 * - If the directory is missing, clone fresh.
 * - Otherwise, fetch and hard-reset to `origin/<branch>`.
 */
export async function syncRepo(
  workDir: string,
  project: ProjectConfig,
): Promise<RepoHandle> {
  const path = repoDir(workDir, project);

  if (project.localPath) {
    const git = simpleGit({ baseDir: path });
    const head = (await git.revparse(['HEAD'])).trim();
    return { path, head };
  }

  if (!project.repo) {
    throw new Error(`Project "${project.name}" has neither localPath nor repo`);
  }

  const branch = project.branch ?? 'main';
  const token = project.tokenEnv ? process.env[project.tokenEnv] : process.env['GIT_TOKEN'];
  const cloneUrl = withToken(project.repo, token);

  if (!existsSync(path)) {
    mkdirSync(workDir, { recursive: true });
    const git = simpleGit({ baseDir: workDir });
    await git.clone(cloneUrl, project.name, ['--branch', branch, '--single-branch']);
  } else {
    const git = simpleGit({ baseDir: path });
    // Refresh origin to pick up token changes between runs.
    await git.remote(['set-url', 'origin', cloneUrl]);
    await git.fetch('origin', branch);
    await git.checkout(branch);
    await git.reset(['--hard', `origin/${branch}`]);
  }

  const git = simpleGit({ baseDir: path });
  const head = (await git.revparse(['HEAD'])).trim();
  return { path, head };
}

/**
 * List files changed between `fromSha` and HEAD. Returns paths relative to the repo root.
 * Renames count as a deletion of the old path + addition of the new path so callers
 * can remove stale chunks before re-indexing.
 */
export async function changedFiles(
  repoPath: string,
  fromSha: string,
): Promise<{ added: string[]; deleted: string[] }> {
  const git: SimpleGit = simpleGit({ baseDir: repoPath });
  const raw = await git.raw(['diff', '--name-status', '-M', `${fromSha}..HEAD`]);
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('A') || status.startsWith('M')) {
      const p = parts[1];
      if (p) added.push(p);
    } else if (status.startsWith('D')) {
      const p = parts[1];
      if (p) deleted.push(p);
    } else if (status.startsWith('R')) {
      const oldP = parts[1];
      const newP = parts[2];
      if (oldP) deleted.push(oldP);
      if (newP) added.push(newP);
    }
  }
  return { added, deleted };
}

/** Repo root for a fresh clone — just walks ahead and returns the absolute path. */
export function joinRepo(repoPath: string, relative: string): string {
  return join(repoPath, relative);
}
