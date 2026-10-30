import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { configureLogging, createLogger } from '../src/index.js';

test('JSON lines keep bound fields and an error with its cause, and entries below the level are dropped', () => {
  const lines: string[] = [];
  const write = (line: string) => void lines.push(line);
  mock.method(console, 'log', write);
  mock.method(console, 'error', write);
  configureLogging({ level: 'info', format: 'json' });

  const log = createLogger('tmdb').child({ rid: 'r1' });
  log.debug({}, 'not shown');
  log.error(
    { err: new Error('lookup failed', { cause: new Error('socket hang up') }) },
    'could not load a title'
  );

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'error');
  assert.equal(entry.module, 'tmdb');
  assert.equal(entry.rid, 'r1');
  assert.equal(entry.msg, 'could not load a title');
  assert.equal(entry.err.message, 'lookup failed');
  assert.equal(entry.err.cause.message, 'socket hang up');
  assert.match(entry.err.stack, /lookup failed/);
});
