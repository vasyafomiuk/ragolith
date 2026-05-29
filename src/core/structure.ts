// Pure file-tree builder. Turns a flat list of indexed files into a
// directory-grouped structure with per-directory and per-language counts — a
// fast orientation map of a project without reading any file contents.

export interface FileEntry {
  file_path: string;
  project?: string;
  language?: string;
}

export interface DirNode {
  /** Directory path with forward slashes; `(root)` for top-level files. */
  dir: string;
  files: number;
  languages: Record<string, number>;
  paths: string[];
}

export interface ProjectStructure {
  totalFiles: number;
  languages: Record<string, number>;
  directories: DirNode[];
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Directory portion of a path; `(root)` when the file sits at the top. */
export function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '(root)' : path.slice(0, idx);
}

/**
 * Group files by directory. Deduplicates on `project::path` so the same file
 * indexed as many chunks counts once. Directories and the paths within them
 * are returned in stable sorted order.
 */
export function buildProjectStructure(files: FileEntry[]): ProjectStructure {
  const seen = new Set<string>();
  const byDir = new Map<string, DirNode>();
  const langTotals: Record<string, number> = {};
  let total = 0;

  for (const f of files) {
    const path = normalizeSlashes(f.file_path ?? '');
    if (!path) continue;
    const key = `${f.project ?? ''}::${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total++;

    const lang = f.language && f.language.length > 0 ? f.language : 'unknown';
    langTotals[lang] = (langTotals[lang] ?? 0) + 1;

    const dir = dirOf(path);
    let node = byDir.get(dir);
    if (!node) {
      node = { dir, files: 0, languages: {}, paths: [] };
      byDir.set(dir, node);
    }
    node.files++;
    node.languages[lang] = (node.languages[lang] ?? 0) + 1;
    node.paths.push(path);
  }

  const directories = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  for (const d of directories) d.paths.sort();
  return { totalFiles: total, languages: langTotals, directories };
}
