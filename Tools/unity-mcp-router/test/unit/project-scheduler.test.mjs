import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectScheduler,
  SchedulerBudget,
  SchedulerError,
} from '../../lib/project-scheduler.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const SAFE_READ = Object.freeze({ kind: 'safe_read', heavy: false });
const HEAVY = Object.freeze({ kind: 'heavy', heavy: true });

test('single-flights a project and round-robins active clients without breaking client FIFO', async () => {
  const scheduler = new ProjectScheduler({ projectKey: 'project-a' });
  const order = [];
  let active = 0;
  let maxActive = 0;
  const enqueue = (clientId, operationId) =>
    scheduler.enqueue({
      clientId,
      operationId,
      classification: SAFE_READ,
      async run() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(operationId);
        await tick();
        active -= 1;
        return operationId;
      },
    });

  const results = await Promise.all([
    enqueue('A', 'A1'),
    enqueue('A', 'A2'),
    enqueue('B', 'B1'),
    enqueue('B', 'B2'),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['A1', 'B1', 'A2', 'B2']);
  assert.deepEqual(results, ['A1', 'A2', 'B1', 'B2']);
  assert.equal(scheduler.snapshot().pending, 0);
  scheduler.close();
});

test('different projects overlap light work through a shared budget', async () => {
  const budget = new SchedulerBudget({ maxPendingTotal: 8, maxHeavyInFlight: 1 });
  const a = new ProjectScheduler({ projectKey: 'a', budget });
  const b = new ProjectScheduler({ projectKey: 'b', budget });
  const gateA = deferred();
  const gateB = deferred();
  let active = 0;
  let maxActive = 0;
  const run = (gate) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
  };

  const pa = a.enqueue({ clientId: 'c1', operationId: 'a1', classification: SAFE_READ, run: run(gateA) });
  const pb = b.enqueue({ clientId: 'c2', operationId: 'b1', classification: SAFE_READ, run: run(gateB) });
  await tick();
  assert.equal(maxActive, 2);
  gateA.resolve();
  gateB.resolve();
  await Promise.all([pa, pb]);
  a.close();
  b.close();
});

test('shared budget permits only one heavy operation across projects', async () => {
  const budget = new SchedulerBudget({ maxPendingTotal: 8, maxHeavyInFlight: 1 });
  const a = new ProjectScheduler({ projectKey: 'a', budget });
  const b = new ProjectScheduler({ projectKey: 'b', budget });
  const gates = [deferred(), deferred()];
  const starts = [];
  let activeHeavy = 0;
  let maxHeavy = 0;
  const makeRun = (name, gate) => async () => {
    starts.push(name);
    activeHeavy += 1;
    maxHeavy = Math.max(maxHeavy, activeHeavy);
    await gate.promise;
    activeHeavy -= 1;
  };

  const pa = a.enqueue({ clientId: 'ca', operationId: 'ha', classification: HEAVY, run: makeRun('a', gates[0]) });
  const pb = b.enqueue({ clientId: 'cb', operationId: 'hb', classification: HEAVY, run: makeRun('b', gates[1]) });
  await tick();
  assert.equal(starts.length, 1);
  assert.equal(maxHeavy, 1);
  gates[starts[0] === 'a' ? 0 : 1].resolve();
  await tick();
  await tick();
  assert.equal(starts.length, 2);
  gates[starts[1] === 'a' ? 0 : 1].resolve();
  await Promise.all([pa, pb]);
  assert.equal(maxHeavy, 1);
  a.close();
  b.close();
});

test('rotates the shared heavy wake-up so an older project cannot starve a later project', async () => {
  const budget = new SchedulerBudget({ maxPendingTotal: 16, maxHeavyInFlight: 1 });
  const a = new ProjectScheduler({ projectKey: 'a', budget });
  const b = new ProjectScheduler({ projectKey: 'b', budget });
  const order = [];
  const enqueue = (scheduler, clientId, operationId) => scheduler.enqueue({
    clientId,
    operationId,
    classification: HEAVY,
    run: async () => {
      order.push(operationId);
      await tick();
    },
  });

  const work = [
    enqueue(a, 'ca', 'a1'),
    enqueue(a, 'ca', 'a2'),
    enqueue(a, 'ca', 'a3'),
    enqueue(a, 'ca', 'a4'),
    enqueue(a, 'ca', 'a5'),
    enqueue(b, 'cb', 'b1'),
  ];
  await Promise.all(work);
  assert(order.indexOf('b1') < order.indexOf('a5'), JSON.stringify(order));
  a.close();
  b.close();
});

test('enforces per-client and per-project backpressure', async () => {
  const scheduler = new ProjectScheduler({
    projectKey: 'limited',
    maxPendingPerClient: 2,
    maxPendingPerProject: 3,
  });
  const gate = deferred();
  const first = scheduler.enqueue({
    clientId: 'A',
    operationId: 'A1',
    classification: SAFE_READ,
    run: () => gate.promise,
  });
  const second = scheduler.enqueue({
    clientId: 'A',
    operationId: 'A2',
    classification: SAFE_READ,
    run: async () => {},
  });
  await assert.rejects(
    scheduler.enqueue({
      clientId: 'A',
      operationId: 'A3',
      classification: SAFE_READ,
      run: async () => {},
    }),
    (error) => error instanceof SchedulerError && error.code === 'CLIENT_QUEUE_FULL',
  );
  const third = scheduler.enqueue({
    clientId: 'B',
    operationId: 'B1',
    classification: SAFE_READ,
    run: async () => {},
  });
  await assert.rejects(
    scheduler.enqueue({
      clientId: 'B',
      operationId: 'B2',
      classification: SAFE_READ,
      run: async () => {},
    }),
    (error) => error instanceof SchedulerError && error.code === 'PROJECT_QUEUE_FULL',
  );
  gate.resolve();
  await Promise.all([first, second, third]);
  scheduler.close();
});

test('enforces total backpressure across projects', async () => {
  const budget = new SchedulerBudget({ maxPendingTotal: 1, maxHeavyInFlight: 1 });
  const a = new ProjectScheduler({ projectKey: 'a', budget });
  const b = new ProjectScheduler({ projectKey: 'b', budget });
  const gate = deferred();
  const first = a.enqueue({
    clientId: 'A',
    operationId: 'A1',
    classification: SAFE_READ,
    run: () => gate.promise,
  });
  await assert.rejects(
    b.enqueue({
      clientId: 'B',
      operationId: 'B1',
      classification: SAFE_READ,
      run: async () => {},
    }),
    (error) => error instanceof SchedulerError && error.code === 'TOTAL_QUEUE_FULL',
  );
  gate.resolve();
  await first;
  a.close();
  b.close();
});

test('queued cancellation rejects without dispatching the operation', async () => {
  const scheduler = new ProjectScheduler({ projectKey: 'cancel' });
  const gate = deferred();
  const first = scheduler.enqueue({
    clientId: 'A',
    operationId: 'active',
    classification: SAFE_READ,
    run: () => gate.promise,
  });
  let dispatched = false;
  const queued = scheduler.enqueue({
    clientId: 'B',
    operationId: 'queued',
    classification: SAFE_READ,
    run: async () => {
      dispatched = true;
    },
  });
  await tick();
  assert.equal(scheduler.cancel('queued', 'test cancellation'), true);
  assert.equal(scheduler.cancel('active', 'too late'), false);
  await assert.rejects(
    queued,
    (error) => error instanceof SchedulerError && error.code === 'CANCELLED',
  );
  gate.resolve();
  await first;
  assert.equal(dispatched, false);
  scheduler.close();
});

test('expired queued work is rejected before dispatch', async () => {
  let now = 0;
  const scheduler = new ProjectScheduler({ projectKey: 'deadline', now: () => now, deadlineMs: 100 });
  const gate = deferred();
  const first = scheduler.enqueue({
    clientId: 'A',
    operationId: 'active',
    classification: SAFE_READ,
    run: () => gate.promise,
  });
  let dispatched = false;
  const expired = scheduler.enqueue({
    clientId: 'B',
    operationId: 'expired',
    classification: SAFE_READ,
    deadlineAt: 50,
    run: async () => {
      dispatched = true;
    },
  });
  await tick();
  now = 60;
  gate.resolve();
  await first;
  await assert.rejects(
    expired,
    (error) => error instanceof SchedulerError && error.code === 'DEADLINE_EXCEEDED',
  );
  assert.equal(dispatched, false);
  scheduler.close();
});

test('a durable heavy hold consumes the global slot until explicitly released', async () => {
  const budget = new SchedulerBudget({ maxPendingTotal: 8, maxHeavyInFlight: 1 });

  assert.equal(budget.holdHeavy('timed-out-build'), true);
  assert.equal(budget.holdHeavy('timed-out-build'), false);
  assert.equal(budget.hasHeavyHold('timed-out-build'), true);
  assert.deepEqual(budget.listHeavyHolds(), ['timed-out-build']);
  assert.deepEqual(budget.snapshot(), {
    pendingTotal: 0,
    maxPendingTotal: 8,
    activeHeavy: 1,
    runningHeavy: 0,
    heldHeavy: 1,
    maxHeavyInFlight: 1,
  });
  assert.equal(budget.tryStart(HEAVY), false);
  assert.equal(budget.tryStart(SAFE_READ), true);

  assert.equal(budget.releaseHeavyHold('timed-out-build'), true);
  assert.equal(budget.releaseHeavyHold('timed-out-build'), false);
  assert.equal(budget.tryStart(HEAVY), true);
  budget.finish(HEAVY);
  assert.equal(budget.snapshot().activeHeavy, 0);
});
