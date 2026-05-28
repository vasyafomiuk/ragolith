// Tiny structured logger.
//
// Two formats, picked by the LOG_FORMAT env var:
//   - text  (default): keeps the existing [ingest] / [server] visual look
//   - json:  one JSON object per line, machine-parseable for log aggregators
//
// Levels: debug | info | warn | error. Filtered by LOG_LEVEL env var (default
// 'info'). All output goes to stderr — stdout is reserved for protocol
// responses (MCP JSON-RPC, doctor --json output, etc).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function envFormat(): 'text' | 'json' {
  return process.env['LOG_FORMAT'] === 'json' ? 'json' : 'text';
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Spawn a child logger that adds default fields to every emit. */
  child(fields: Record<string, unknown>): Logger;
}

function emit(
  level: LogLevel,
  scope: string,
  msg: string,
  fields: Record<string, unknown> | undefined,
  defaults: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[envLevel()]) return;
  const merged = { ...defaults, ...(fields ?? {}) };
  if (envFormat() === 'json') {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...merged,
    };
    process.stderr.write(JSON.stringify(payload) + '\n');
    return;
  }
  // Text format: preserve the historical [scope] prefix + msg layout. Fields
  // are appended as space-separated key=value pairs if any are present.
  let line = `[${scope}] ${msg}`;
  const keys = Object.keys(merged);
  if (keys.length > 0) {
    const pairs = keys.map((k) => {
      const v = merged[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s}`;
    });
    line += ` ${pairs.join(' ')}`;
  }
  process.stderr.write(line + '\n');
}

export function createLogger(scope: string, defaults: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields, defaults),
    info: (msg, fields) => emit('info', scope, msg, fields, defaults),
    warn: (msg, fields) => emit('warn', scope, msg, fields, defaults),
    error: (msg, fields) => emit('error', scope, msg, fields, defaults),
    child: (fields) => createLogger(scope, { ...defaults, ...fields }),
  };
}
