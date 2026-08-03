import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LeaseCancelledError,
  LeaseIdentityError,
  LeaseManager,
} from '../../lib/lease-manager.mjs';

function createManager(options = {}) {
  let nextId = 0;
  return new LeaseManager({
    autoSweep: false,
    idFactory: () => `lease-test-${++nextId}`,
    ...options,
  });
}

const identity = (name) => ({ ownerId: `owner-${name}`, sessionNonce: `session-${name}` });

test('default capacities fail closed to one Editor seat and one per exclusive resource', async () => {
  const manager = createManager();
  assert.equal(manager.capacityFor('editor-seat'), 1);
  assert.equal(manager.capacityFor('project:/workspace/A'), 1);
  assert.equal(manager.capacityFor('source-refresh'), 1);
  assert.equal(manager.capacityFor('heavy'), 1);
  assert.equal(manager.capacityFor('player-connection'), 1);
  assert.equal(manager.capacityFor('exclusive-editor'), 1);
  assert.equal(manager.capacityFor('device:iphone-1'), 1);
  assert.equal(manager.capacityFor('build-output:/tmp/build'), 1);

  const first = await manager.acquire('editor-seat', identity('a'));
  const secondRequest = manager.acquire('editor-seat', identity('b'));
  assert.equal(secondRequest.status, 'queued');

  manager.release(first, identity('a'));
  const second = await secondRequest;
  assert.equal(second.ownerId, 'owner-b');
  assert.equal(second.state, 'active');
  manager.close();
});

test('an explicit default capacity applies only to otherwise unknown resource keys', () => {
  const manager = createManager({ defaultCapacity: 3 });
  assert.equal(manager.capacityFor('custom-resource'), 3);
  assert.equal(manager.capacityFor('project:/workspace/A'), 1);
  assert.equal(manager.capacityFor('editor-seat'), 1);
  manager.close();
});

test('acquire is FIFO and a queued request can be cancelled without skipping identity checks', async () => {
  const manager = createManager({ capacities: { heavy: 1 } });
  const active = await manager.acquire('heavy', identity('a'));
  const second = manager.acquire('heavy', identity('b'));
  const third = manager.acquire('heavy', identity('c'));
  assert.deepEqual(
    manager.listQueued({ key: 'heavy' }).map((request) => request.ownerId),
    ['owner-b', 'owner-c'],
  );

  assert.throws(
    () => manager.cancel(second, { ownerId: 'owner-b', sessionNonce: 'wrong' }),
    LeaseIdentityError,
  );
  assert.equal(second.cancel('caller cancelled'), true);
  await assert.rejects(second.promise, (error) => {
    assert.ok(error instanceof LeaseCancelledError);
    assert.equal(error.code, 'LEASE_REQUEST_CANCELLED');
    return true;
  });

  manager.release(active, identity('a'));
  const granted = await third.promise;
  assert.equal(granted.ownerId, 'owner-c');
  assert.equal(manager.listQueued({ key: 'heavy' }).length, 0);
  manager.close();
});

test('heartbeat and release require the exact owner and session', async () => {
  const manager = createManager();
  const lease = await manager.acquire('device:pixel', identity('a'));

  assert.throws(
    () => manager.heartbeat(lease, { ownerId: 'owner-a', sessionNonce: 'session-other' }),
    LeaseIdentityError,
  );
  assert.throws(
    () => manager.release(lease, { ownerId: 'owner-other', sessionNonce: 'session-a' }),
    LeaseIdentityError,
  );
  assert.equal(manager.getLease(lease).state, 'active');

  const refreshed = manager.heartbeat(lease, { ...identity('a'), ttlMs: 5_000 });
  assert.equal(refreshed.expiresAt - refreshed.heartbeatAt, 5_000);
  manager.release(lease, identity('a'));
  assert.equal(manager.getLease(lease), null);
  manager.close();
});

test('an expired lease becomes orphaned and is never reassigned automatically', async () => {
  let now = 1_000;
  const manager = createManager({ defaultTtlMs: 10, now: () => now });
  const first = await manager.acquire('player-connection', identity('a'));
  const waiting = manager.acquire('player-connection', identity('b'));
  let waitingSettled = false;
  waiting.promise.then(() => { waitingSettled = true; });

  now = 1_011;
  const orphaned = manager.sweep();
  assert.equal(orphaned.length, 1);
  assert.equal(manager.getLease(first).state, 'orphaned');
  await Promise.resolve();
  assert.equal(waitingSettled, false);
  assert.equal(waiting.status, 'queued');

  const recovered = manager.heartbeat(first, { ...identity('a'), ttlMs: 20 });
  assert.equal(recovered.state, 'active');
  assert.equal(recovered.expiresAt, 1_031);
  assert.equal(waiting.status, 'queued');

  manager.release(first, identity('a'));
  const reassigned = await waiting;
  assert.equal(reassigned.ownerId, 'owner-b');
  manager.close();
});

test('device and build-output keys serialize only callers sharing the exact key', async () => {
  const manager = createManager();
  const phoneA = await manager.acquire('device:phone-a', identity('a'));
  const samePhone = manager.acquire('device:phone-a', identity('b'));
  const phoneB = await manager.acquire('device:phone-b', identity('c'));
  assert.equal(samePhone.status, 'queued');
  assert.equal(phoneB.state, 'active');

  const buildA = await manager.acquire('build-output:/build/A', identity('d'));
  const sameBuild = manager.acquire('build-output:/build/A', identity('e'));
  const buildB = await manager.acquire('build-output:/build/B', identity('f'));
  assert.equal(sameBuild.status, 'queued');
  assert.equal(buildB.state, 'active');

  manager.release(phoneA, identity('a'));
  assert.equal((await samePhone).ownerId, 'owner-b');
  manager.release(buildA, identity('d'));
  assert.equal((await sameBuild).ownerId, 'owner-e');
  manager.close();
});

test('tryAcquire respects existing FIFO waiters', async () => {
  const manager = createManager({ capacities: { 'editor-seat': 1 } });
  const active = await manager.acquire('editor-seat', identity('a'));
  const waiting = manager.acquire('editor-seat', identity('b'));

  assert.equal(manager.tryAcquire('editor-seat', identity('c')), null);
  manager.release(active, identity('a'));
  assert.equal((await waiting).ownerId, 'owner-b');
  manager.close();
});
