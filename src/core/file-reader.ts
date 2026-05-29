// Format-aware file reader.
//
// - .pdf  → pdfjs-dist, page-by-page text extraction (page breaks become double newlines).
// - .docx → mammoth raw text (no styling).
// - other → UTF-8 read.
//
// Returns null when the file looks binary or exceeds the byte limit so the caller can skip it.

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Language } from './types.js';

const EXT_LANG: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.java': 'java',
  '.cs': 'csharp',
  '.sql': 'sql',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.xaml': 'xaml',
  '.razor': 'razor',
  '.cshtml': 'razor',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'text',
};

export function detectLanguage(path: string): Language {
  return EXT_LANG[extname(path).toLowerCase()] ?? 'unknown';
}

export interface ReadResult {
  content: string;
  language: Language;
  bytes: number;
}

async function readPdf(path: string): Promise<string> {
  // pdfjs-dist is ESM in v4. The "legacy" build avoids worker setup for Node usage.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const text = await page.getTextContent();
    const line = text.items
      .map((it: unknown) => {
        const item = it as { str?: string };
        return item.str ?? '';
      })
      .join(' ');
    pages.push(line);
  }
  await doc.destroy();
  return pages.join('\n\n');
}

async function readDocx(path: string): Promise<string> {
  const mammoth = await import('mammoth');
  const buffer = await readFile(path);
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

/** Cheap heuristic: a NUL byte in the first 8KB is almost always binary content. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readSourceFile(path: string, maxBytes: number): Promise<ReadResult | null> {
  const st = await stat(path);
  if (!st.isFile()) return null;
  if (st.size > maxBytes) return null;
  const lang = detectLanguage(path);

  if (lang === 'pdf') {
    const content = await readPdf(path);
    return { content, language: lang, bytes: st.size };
  }
  if (lang === 'docx') {
    const content = await readDocx(path);
    return { content, language: lang, bytes: st.size };
  }

  const buf = await readFile(path);
  if (looksBinary(buf)) return null;
  return { content: buf.toString('utf-8'), language: lang, bytes: st.size };
}
