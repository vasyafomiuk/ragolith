// Small progress reporter for long-running CLIs.
//
// Two modes, picked automatically from stream.isTTY:
//   - TTY:  in-place \r updates throttled to ~10 Hz so we don't flood the
//           terminal; clears the line cleanly on done().
//   - Non-TTY (e.g. CI logs):  emits one fresh line every `nonTtyEvery`
//           ticks, plus one final summary line. No carriage returns.
//
// The writer + isTTY + clock are all injectable so this module is fully
// unit-testable without touching real terminals.

export interface ProgressDelta {
  chunks?: number;
  symbols?: number;
  edges?: number;
  /** A short string identifying the most recent unit processed (file path). */
  detail?: string;
}

export interface ProgressOptions {
  /** Total expected ticks. Used for percentage + 'N/total' display. */
  total: number;
  /** Short label used in the final summary line, e.g. 'src' or 'incremental'. */
  label: string;
  /** Leading whitespace for every output line. */
  indent?: string;
  /** Override the destination stream's writer. Defaults to process.stderr.write. */
  write?: (s: string) => void;
  /** Override TTY detection. Defaults to !!process.stderr.isTTY. */
  isTTY?: boolean;
  /** Minimum ms between TTY refreshes. Defaults to 100ms (~10 Hz). */
  intervalMs?: number;
  /** In non-TTY mode, emit a line every N ticks. Defaults to a 5% cadence. */
  nonTtyEvery?: number;
  /** Override the clock (for tests). Defaults to Date.now. */
  now?: () => number;
}

export interface ProgressReporter {
  /** Advance the counter by one. Optionally accumulate sub-counters and remember a detail string. */
  tick(delta?: ProgressDelta): void;
  /** Print the final summary line. Safe to call once; further ticks are no-ops. */
  done(extra?: string): void;
  /** Current totals — exposed for callers that want to print their own summary. */
  totals(): { n: number; chunks: number; symbols: number; edges: number; elapsedMs: number };
}

const ANSI_CLEAR_LINE = '\x1b[K';

export function createProgress(opts: ProgressOptions): ProgressReporter {
  const indent = opts.indent ?? '    ';
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const isTTY = opts.isTTY ?? !!process.stderr.isTTY;
  const intervalMs = opts.intervalMs ?? 100;
  const nonTtyEvery = opts.nonTtyEvery ?? Math.max(1, Math.floor(opts.total / 20));
  const now = opts.now ?? Date.now;

  const start = now();
  let n = 0;
  let chunks = 0;
  let symbols = 0;
  let edges = 0;
  let detail = '';
  let lastEmit = 0;
  let closed = false;

  function snapshot(): string {
    const pct = opts.total > 0 ? Math.round((n / opts.total) * 100) : 0;
    const counts = `${chunks} chunks · ${symbols} sym · ${edges} edges`;
    const tail = detail ? ` · ${truncate(detail, 50)}` : '';
    return `${indent}${n}/${opts.total} (${pct}%) · ${counts}${tail}`;
  }

  function emitTTY(force = false): void {
    const t = now();
    if (!force && t - lastEmit < intervalMs) return;
    lastEmit = t;
    write(`\r${snapshot()}${ANSI_CLEAR_LINE}`);
  }

  function emitLine(): void {
    write(`${snapshot()}\n`);
  }

  return {
    tick(delta) {
      if (closed) return;
      n++;
      if (delta?.chunks) chunks += delta.chunks;
      if (delta?.symbols) symbols += delta.symbols;
      if (delta?.edges) edges += delta.edges;
      if (delta?.detail) detail = delta.detail;

      if (isTTY) {
        emitTTY(n === opts.total);
      } else if (n === opts.total || n % nonTtyEvery === 0) {
        emitLine();
      }
    },

    done(extra) {
      if (closed) return;
      closed = true;
      const elapsedMs = now() - start;
      const elapsed = (elapsedMs / 1000).toFixed(1);
      // Clear the in-progress carriage-return line in TTY mode so the summary
      // starts at column 0 with no leftover characters.
      if (isTTY) write(`\r${ANSI_CLEAR_LINE}`);
      const summary =
        `${indent}✓ ${opts.label}: ${n} files · ${chunks} chunks · ${symbols} sym · ${edges} edges in ${elapsed}s` +
        (extra ? ` · ${extra}` : '') +
        '\n';
      write(summary);
    },

    totals() {
      return { n, chunks, symbols, edges, elapsedMs: now() - start };
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Keep the end of the string — file paths are most identifiable by their leaf.
  return '…' + s.slice(-(max - 1));
}
