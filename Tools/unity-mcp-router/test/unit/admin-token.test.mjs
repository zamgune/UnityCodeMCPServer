import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadOrCreateAdminToken, readAdminToken, verifyAdminToken } from '../../lib/admin-token.mjs';

test('creates one private persistent admin capability and compares it safely', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'unity-admin-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state', 'admin-token');
  const first = await loadOrCreateAdminToken(file);
  const second = await loadOrCreateAdminToken(file);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.equal(await readAdminToken(file), first);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(verifyAdminToken(first, second), true);
  assert.equal(verifyAdminToken(`${first}0`, second), false);
  assert.equal(verifyAdminToken('x'.repeat(64), second), false);
});

test('rejects a symlink or malformed admin capability file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'unity-admin-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const malformed = path.join(root, 'malformed');
  await writeFile(malformed, 'not-a-token\n', { mode: 0o600 });
  await assert.rejects(readAdminToken(malformed), /32-byte lowercase hex/);
  const link = path.join(root, 'link');
  await symlink(malformed, link);
  await assert.rejects(readAdminToken(link), /regular file/);
});
