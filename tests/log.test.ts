import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger } from '../src/core/log.js';

// Capture process.stderr.write into an array so we can assert on emitted lines.
let writes: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
const savedEnv = { ...process.env };

beforeEach(() => {
  writes = [];
  // @ts-expect-error narrow stub for the test
  process.stderr.write = (chunk: string | Buffer): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realWrite;
  process.env = { ...savedEnv };
});

describe('createLogger — text format', () => {
  it('writes [scope] prefixed lines for info+', () => {
    delete process.env['LOG_FORMAT'];
    delete process.env['LOG_LEVEL'];
    const log = createLogger('ingest');
    log.info('starting');
    log.warn('slow path');
    log.error('boom', { code: 42 });
    assert.equal(writes.length, 3);
    assert.match(writes[0]!, /^\[ingest\] starting\n$/);
    assert.match(writes[1]!, /^\[ingest\] slow path\n$/);
    assert.match(writes[2]!, /^\[ingest\] boom code=42\n$/);
  });

  it('suppresses debug below the configured level', () => {
    delete process.env['LOG_FORMAT'];
    process.env['LOG_LEVEL'] = 'info';
    const log = createLogger('s');
    log.debug('detail');
    log.info('visible');
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /visible/);
  });

  it('honors LOG_LEVEL=debug', () => {
    delete process.env['LOG_FORMAT'];
    process.env['LOG_LEVEL'] = 'debug';
    const log = createLogger('s');
    log.debug('detail');
    log.info('visible');
    assert.equal(writes.length, 2);
  });

  it('serializes structured fields as key=value', () => {
    delete process.env['LOG_FORMAT'];
    delete process.env['LOG_LEVEL'];
    const log = createLogger('search');
    log.info('hit', { project: 'demo', file: 'a.ts', score: 0.95 });
    assert.match(writes[0]!, /project=demo/);
    assert.match(writes[0]!, /file=a\.ts/);
    assert.match(writes[0]!, /score=0\.95/);
  });
});

describe('createLogger — json format', () => {
  it('emits one JSON object per line with ts + level + scope + msg', () => {
    process.env['LOG_FORMAT'] = 'json';
    delete process.env['LOG_LEVEL'];
    const log = createLogger('ingest');
    log.info('starting', { files: 4500 });
    assert.equal(writes.length, 1);
    const obj = JSON.parse(writes[0]!.trim()) as Record<string, unknown>;
    assert.equal(obj['level'], 'info');
    assert.equal(obj['scope'], 'ingest');
    assert.equal(obj['msg'], 'starting');
    assert.equal(obj['files'], 4500);
    assert.match(String(obj['ts']), /^\d{4}-\d{2}-\d{2}T/); // ISO date
  });

  it('still filters by LOG_LEVEL in json mode', () => {
    process.env['LOG_FORMAT'] = 'json';
    process.env['LOG_LEVEL'] = 'warn';
    const log = createLogger('s');
    log.info('quiet');
    log.warn('loud');
    assert.equal(writes.length, 1);
    const obj = JSON.parse(writes[0]!.trim()) as Record<string, unknown>;
    assert.equal(obj['level'], 'warn');
  });
});

describe('createLogger — child loggers', () => {
  it('child merges default fields into every emit', () => {
    process.env['LOG_FORMAT'] = 'json';
    delete process.env['LOG_LEVEL'];
    const log = createLogger('ingest').child({ project: 'demo' });
    log.info('starting');
    log.info('done', { files: 42 });
    const a = JSON.parse(writes[0]!.trim()) as Record<string, unknown>;
    const b = JSON.parse(writes[1]!.trim()) as Record<string, unknown>;
    assert.equal(a['project'], 'demo');
    assert.equal(b['project'], 'demo');
    assert.equal(b['files'], 42);
  });

  it('child of a child accumulates defaults', () => {
    process.env['LOG_FORMAT'] = 'json';
    delete process.env['LOG_LEVEL'];
    const log = createLogger('ingest').child({ project: 'demo' }).child({ sub: 'src' });
    log.info('walking');
    const obj = JSON.parse(writes[0]!.trim()) as Record<string, unknown>;
    assert.equal(obj['project'], 'demo');
    assert.equal(obj['sub'], 'src');
  });
});
