import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { redactLogValue, StructuredLogger } from '../../lib/logger.mjs';

test('redacts sensitive keys, bearer values, and JWT-shaped strings', () => {
  const value = redactLogValue({
    token: 'plain-secret',
    nested: {
      Authorization: 'Bearer abc.def-123',
      note: 'prefix eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature suffix --accessToken hub-secret token="plain-secret"',
    },
    args: ['--token', 'plain-secret', '--safe', 'ok'],
  });
  assert.equal(value.token, '[REDACTED]');
  assert.equal(value.nested.Authorization, '[REDACTED]');
  assert(!value.nested.note.includes('eyJ'));
  assert(!value.nested.note.includes('hub-secret'));
  assert(!value.nested.note.includes('plain-secret'));
  assert.deepEqual(value.args, ['--token', '[REDACTED]', '--safe', 'ok']);
});

test('writes JSONL and rotates without breaking the caller', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'unity-router-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'broker.log');
  await writeFile(file, 'x'.repeat(64));
  const logger = new StructuredLogger(file, { maxBytes: 32, maxFiles: 2 });
  logger.info('hello', { password: 'never-log-me' });
  assert.equal((await readFile(`${file}.1`, 'utf8')).length, 64);
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.message, 'hello');
  assert.equal(record.extra.password, '[REDACTED]');
  assert.equal((await stat(file)).mode & 0o077, 0);
});
