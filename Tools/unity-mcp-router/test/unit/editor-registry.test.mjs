import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalProjectId,
  DuplicatePidError,
  DuplicateProjectError,
  EditorIdentityError,
  EditorRegistry,
  EditorSeatCapacityError,
} from '../../lib/editor-registry.mjs';
import { LeaseManager } from '../../lib/lease-manager.mjs';

function registration(name, pid, overrides = {}) {
  return {
    projectId: `/workspace/${name}`,
    pid,
    version: '6000.3.13f1',
    sessionNonce: `nonce-${name}`,
    mode: 'managed',
    logPaths: {
      editor: `/logs/${name}/Editor.log`,
      upm: `/logs/${name}/upm.log`,
    },
    ...overrides,
  };
}

function exactIdentity(entry) {
  return {
    projectId: entry.projectId,
    pid: entry.pid,
    version: entry.version,
    sessionNonce: entry.sessionNonce,
  };
}

test('canonical project ids collapse path aliases before duplicate checks', () => {
  assert.equal(
    canonicalProjectId('/workspace/game/../game'),
    path.resolve('/workspace/game'),
  );
  assert.equal(canonicalProjectId('dev:16777233:ino:12345'), 'dev:16777233:ino:12345');

  const registry = new EditorRegistry({ autoSweep: false });
  const first = registration('game', 101);
  registry.register(first);
  assert.throws(
    () => registry.register(registration('game/../game', 102, { sessionNonce: 'nonce-other' })),
    DuplicateProjectError,
  );
  registry.close();
});

test('registry stores exact identity, logs and managed/external mode', () => {
  const registry = new EditorRegistry({ autoSweep: false, seatCapacity: 2 });
  const managed = registration('managed', 201);
  const external = registration('external', 202, { mode: 'external' });

  const managedRecord = registry.register(managed);
  const externalRecord = registry.register(external);
  assert.equal(managedRecord.projectId, path.resolve(managed.projectId));
  assert.equal(managedRecord.pid, managed.pid);
  assert.equal(managedRecord.version, managed.version);
  assert.equal(managedRecord.sessionNonce, managed.sessionNonce);
  assert.deepEqual(managedRecord.logPaths, {
    editor: path.resolve(managed.logPaths.editor),
    upm: path.resolve(managed.logPaths.upm),
  });
  assert.equal(managedRecord.mode, 'managed');
  assert.equal(externalRecord.mode, 'external');
  assert.equal(registry.list({ mode: 'external' }).length, 1);

  assert.deepEqual(registry.findExact(exactIdentity(managed)), managedRecord);
  assert.equal(registry.findExact({ ...exactIdentity(managed), version: 'wrong' }), null);
  assert.equal(registry.findExact({ ...exactIdentity(managed), sessionNonce: 'wrong' }), null);
  registry.close();
});

test('same project, same PID and seat overflow are blocked fail-closed', () => {
  const registry = new EditorRegistry({ autoSweep: false, seatCapacity: 2 });
  const first = registration('a', 301);
  const second = registration('b', 302);
  const third = registration('c', 303);
  registry.register(first);

  assert.throws(
    () => registry.register(registration('a', 304, { sessionNonce: 'nonce-a2' })),
    DuplicateProjectError,
  );
  assert.throws(
    () => registry.register(registration('other', 301, { sessionNonce: 'nonce-pid' })),
    DuplicatePidError,
  );

  registry.register(second);
  assert.throws(() => registry.register(third), EditorSeatCapacityError);
  assert.equal(registry.size, 2);
  assert.equal(registry.leaseManager.list({ key: `project:${path.resolve(third.projectId)}` }).length, 0);

  registry.unregister(exactIdentity(first));
  assert.equal(registry.register(third).pid, 303);
  registry.close();
});

test('an exact duplicate registration is idempotent but identity-protected operations are strict', () => {
  const registry = new EditorRegistry({ autoSweep: false });
  const editor = registration('idempotent', 401);
  const first = registry.register(editor);
  const second = registry.register(editor);
  assert.deepEqual(second, first);
  assert.equal(registry.size, 1);

  assert.throws(
    () => registry.heartbeat({ ...exactIdentity(editor), sessionNonce: 'other' }),
    EditorIdentityError,
  );
  assert.throws(
    () => registry.unregister({ ...exactIdentity(editor), pid: 999 }),
    EditorIdentityError,
  );
  assert.equal(registry.size, 1);

  const refreshed = registry.heartbeat(exactIdentity(editor), { ttlMs: 5_000 });
  assert.equal(refreshed.expiresAt - refreshed.heartbeatAt, 5_000);
  registry.close();
});

test('orphaned Editors keep project and seat capacity until exact recovery or unregister', () => {
  let now = 5_000;
  let id = 0;
  const leases = new LeaseManager({
    autoSweep: false,
    defaultTtlMs: 10,
    now: () => now,
    idFactory: () => `registry-lease-${++id}`,
    capacities: { 'editor-seat': 1 },
  });
  const registry = new EditorRegistry({
    leaseManager: leases,
    canonicalizeProjectId: (value) => path.resolve(String(value)),
  });
  const first = registration('orphan', 501, { ttlMs: 10 });
  registry.register(first);

  now = 5_011;
  const orphaned = registry.sweep();
  assert.equal(orphaned.length, 1);
  assert.equal(registry.getByProject(first.projectId).state, 'orphaned');
  assert.throws(() => registry.register(registration('next', 502)), EditorSeatCapacityError);
  assert.throws(
    () => registry.register(registration('orphan', 503, { sessionNonce: 'replacement' })),
    DuplicateProjectError,
  );

  const recovered = registry.heartbeat(exactIdentity(first), { ttlMs: 20 });
  assert.equal(recovered.state, 'active');
  assert.equal(recovered.expiresAt, 5_031);
  registry.unregister(exactIdentity(first));
  assert.equal(registry.register(registration('next', 502)).pid, 502);
  leases.close();
});

test('unregister only releases broker state and never asks to terminate the Editor', () => {
  let terminateCalls = 0;
  const registry = new EditorRegistry({
    autoSweep: false,
    // Deliberately ignored: the registry has no process-control contract.
    terminateEditor() { terminateCalls += 1; },
  });
  const external = registration('external-only', 601, { mode: 'external' });
  registry.register(external);
  const removed = registry.unregister(exactIdentity(external));

  assert.equal(removed.state, 'unregistered');
  assert.equal(terminateCalls, 0);
  assert.equal(registry.size, 0);
  registry.close();
});
