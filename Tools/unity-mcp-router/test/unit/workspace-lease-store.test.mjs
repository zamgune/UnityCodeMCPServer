import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE_FS_OPS,
  WorkspaceLeaseStore,
} from '../../lib/workspace-lease-store.mjs';

test('persists, updates, and removes workspace leases with private permissions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-lease-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'leases.json');
  const store = await WorkspaceLeaseStore.open(file);
  const record = store.create({
    projectKey: 'dev:1:ino:2', projectName: 'A', ownerId: 'client', sessionNonce: 'session', expiresAt: Date.now() + 1_000,
  });
  await store.upsert(record);
  await store.upsert({ ...record, heartbeatAt: record.heartbeatAt + 10, expiresAt: record.expiresAt + 10 });
  await store.close();
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reopened = await WorkspaceLeaseStore.open(file);
  assert.equal(reopened.get(record.token).expiresAt, record.expiresAt + 10);
  await reopened.remove(record.token);
  assert.equal(reopened.list().length, 0);
  await reopened.close();
});

test('fails closed when more than one global workspace lease is persisted', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-lease-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'leases.json');
  const now = Date.now();
  const base = {
    projectKey: 'dev:1:ino:2', projectName: 'A', ownerId: 'client', sessionNonce: 'session',
    acquiredAt: now, heartbeatAt: now, expiresAt: now + 1_000,
  };
  await writeFile(file, `${JSON.stringify({
    version: 1,
    leases: [
      { ...base, token: 'one' },
      { ...base, token: 'two', projectKey: 'dev:1:ino:3', projectName: 'B' },
    ],
  })}\n`);
  await assert.rejects(
    WorkspaceLeaseStore.open(file),
    /more than one global source-refresh lease/,
  );
});

test('repairs an existing regular file to 0600 and rejects a symlink store', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-lease-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'leases.json');
  await writeFile(file, '{"version":1,"leases":[]}\n', { mode: 0o644 });
  await chmod(file, 0o644);
  const store = await WorkspaceLeaseStore.open(file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.close();

  const target = path.join(root, 'target.json');
  const link = path.join(root, 'linked.json');
  await writeFile(target, '{"version":1,"leases":[]}\n', { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(WorkspaceLeaseStore.open(link), /regular file/);
});

test('rolls memory back before rename and becomes unhealthy after a post-rename fsync failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-lease-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const input = {
    projectKey: 'dev:1:ino:2', projectName: 'A', ownerId: 'client', sessionNonce: 'session',
    expiresAt: now + 60_000,
  };

  const precommitFile = path.join(root, 'precommit.json');
  const precommitStore = await WorkspaceLeaseStore.open(precommitFile, {
    fsOps: {
      ...DEFAULT_WORKSPACE_FS_OPS,
      async rename() { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); },
    },
  });
  const precommitRecord = precommitStore.create(input);
  await assert.rejects(precommitStore.upsert(precommitRecord), { code: 'WORKSPACE_STORE_WRITE_FAILED' });
  assert.equal(precommitStore.list().length, 0);
  assert.equal(precommitStore.health().ok, true);
  await precommitStore.close();

  const committedFile = path.join(root, 'committed.json');
  let renamed = false;
  const committedStore = await WorkspaceLeaseStore.open(committedFile, {
    fsOps: {
      ...DEFAULT_WORKSPACE_FS_OPS,
      async rename(from, to) {
        await DEFAULT_WORKSPACE_FS_OPS.rename(from, to);
        renamed = true;
      },
      async open(target, ...args) {
        const handle = await DEFAULT_WORKSPACE_FS_OPS.open(target, ...args);
        if (renamed && target === root) {
          return {
            async sync() { throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' }); },
            async close() { await handle.close(); },
          };
        }
        return handle;
      },
    },
  });
  const committedRecord = committedStore.create(input);
  await assert.rejects(committedStore.upsert(committedRecord), (error) =>
    error.code === 'WORKSPACE_STORE_DURABILITY_UNCERTAIN' && error.committed === true);
  assert.equal(committedStore.list().length, 1);
  assert.equal(committedStore.health().ok, false);
  assert.equal(JSON.parse(await readFile(committedFile, 'utf8')).leases.length, 1);
  await assert.rejects(committedStore.remove(committedRecord.token), {
    code: 'WORKSPACE_STORE_DURABILITY_UNCERTAIN',
  });
  await committedStore.close();
});
