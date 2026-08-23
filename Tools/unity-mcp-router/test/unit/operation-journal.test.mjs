import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OPERATION_STATES,
  OperationJournal,
  OperationJournalError,
  sha256Payload,
} from '../../lib/operation-journal.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'unity-operation-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'operations.ndjson');
}

function rejectsWithCode(code) {
  return (error) => error instanceof OperationJournalError && error.code === code;
}

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 2, 0, 0, tick++));
}

test('persists the strict operation lifecycle and supports defensive lookup', async (t) => {
  const filePath = await fixture(t);
  const journal = await OperationJournal.open(filePath, { clock: tickingClock() });
  const secret = 'raw-eval-token-must-never-be-written';

  const received = await journal.recordReceived({
    operationId: 'op-1',
    project: 'SheepWolf',
    projectKey: 'dev:1:ino:2',
    method: 'eval',
    payload: { code: secret, nested: { b: 2, a: 1 } },
  });
  assert.equal(received.state, OPERATION_STATES.RECEIVED);
  assert.match(received.payloadSha256, /^[a-f0-9]{64}$/);

  await journal.markQueued('op-1');
  await journal.markDispatching('op-1');
  await journal.markCompleted('op-1');
  await journal.flush();

  const operation = journal.get('op-1');
  assert.equal(operation.state, OPERATION_STATES.COMPLETED);
  assert.equal(operation.projectKey, 'dev:1:ino:2');
  operation.state = 'MUTATED_COPY';
  assert.equal(journal.get('op-1').state, OPERATION_STATES.COMPLETED);
  assert.equal(journal.get('missing'), null);
  assert.equal(journal.list({ state: OPERATION_STATES.COMPLETED }).length, 1);

  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(persisted, /"(?:payload|args|arguments|params|result)"\s*:/i);
  assert.deepEqual(
    persisted.trimEnd().split('\n').map((line) => JSON.parse(line).state),
    [
      OPERATION_STATES.RECEIVED,
      OPERATION_STATES.QUEUED,
      OPERATION_STATES.DISPATCHING,
      OPERATION_STATES.COMPLETED,
    ],
  );
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  await journal.close();
});

test('payload hashes are deterministic and raw payload objects are not retained', async (t) => {
  const filePath = await fixture(t);
  assert.equal(sha256Payload({ b: 2, a: 1 }), sha256Payload({ a: 1, b: 2 }));
  assert.notEqual(sha256Payload('abc'), sha256Payload('abd'));

  const payload = { token: 'change-me-after-record' };
  const expected = sha256Payload(payload);
  const journal = await OperationJournal.open(filePath);
  await journal.recordReceived({ operationId: 'op-hash', payload });
  payload.token = 'mutated';

  assert.equal(journal.get('op-hash').payloadSha256, expected);
  assert.equal(JSON.stringify(journal.get('op-hash')).includes('change-me-after-record'), false);
  assert.equal((await readFile(filePath, 'utf8')).includes('change-me-after-record'), false);
  await journal.close();
});

test('serializes concurrent lifecycle calls in invocation order and flushes each append', async (t) => {
  const filePath = await fixture(t);
  const journal = await OperationJournal.open(filePath, { clock: tickingClock() });

  const received = journal.recordReceived({ operationId: 'op-concurrent', payload: {} });
  const queued = journal.markQueued('op-concurrent');
  const dispatching = journal.markDispatching('op-concurrent');
  const completed = journal.markCompleted('op-concurrent');
  await Promise.all([received, queued, dispatching, completed]);

  assert.equal(journal.get('op-concurrent').state, OPERATION_STATES.COMPLETED);
  const records = (await readFile(filePath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(({ state }) => state), [
    OPERATION_STATES.RECEIVED,
    OPERATION_STATES.QUEUED,
    OPERATION_STATES.DISPATCHING,
    OPERATION_STATES.COMPLETED,
  ]);
  await journal.close();
});

test('rejects invalid transitions without poisoning later valid writes', async (t) => {
  const filePath = await fixture(t);
  const journal = await OperationJournal.open(filePath);
  await journal.recordReceived({ operationId: 'op-invalid', payload: {} });

  await assert.rejects(journal.markCompleted('op-invalid'), rejectsWithCode('JOURNAL_INVALID_TRANSITION'));
  assert.equal((await journal.markQueued('op-invalid')).state, OPERATION_STATES.QUEUED);
  await assert.rejects(
    journal.recordReceived({ operationId: 'op-invalid', payload: {} }),
    rejectsWithCode('JOURNAL_DUPLICATE_OPERATION'),
  );
  assert.equal((await journal.markDispatching('op-invalid')).state, OPERATION_STATES.DISPATCHING);
  await journal.close();
});

test('recovers DISPATCHING to durable UNKNOWN_OUTCOME on restart', async (t) => {
  const filePath = await fixture(t);
  const first = await OperationJournal.open(filePath, { clock: tickingClock() });
  await first.recordReceived({
    operationId: 'op-crash',
    project: 'DigitalPet',
    method: 'digitalpet_build_android_dev',
    payload: { development: true },
  });
  await first.markQueued('op-crash');
  await first.markDispatching('op-crash');
  await first.close();

  const restarted = await OperationJournal.open(filePath, { clock: tickingClock() });
  const recovered = restarted.get('op-crash');
  assert.equal(recovered.state, OPERATION_STATES.UNKNOWN_OUTCOME);
  assert.equal(recovered.recoveredAfterRestart, true);

  const records = (await readFile(filePath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(records.at(-1), {
    version: 2,
    operationId: 'op-crash',
    state: OPERATION_STATES.UNKNOWN_OUTCOME,
    at: '2026-08-02T00:00:00.000Z',
    recovery: 'restart',
  });
  await assert.rejects(restarted.markCompleted('op-crash'), rejectsWithCode('JOURNAL_INVALID_TRANSITION'));
  await restarted.close();

  const secondRestart = await OperationJournal.open(filePath);
  assert.equal(secondRestart.get('op-crash').state, OPERATION_STATES.UNKNOWN_OUTCOME);
  assert.equal((await readFile(filePath, 'utf8')).trimEnd().split('\n').length, 4);
  await secondRestart.close();
});

test('keeps RECEIVED and QUEUED operations intact across restart', async (t) => {
  const filePath = await fixture(t);
  const first = await OperationJournal.open(filePath);
  await first.recordReceived({ operationId: 'received', payload: {} });
  await first.recordReceived({ operationId: 'queued', payload: {} });
  await first.markQueued('queued');
  await first.close();

  const restarted = await OperationJournal.open(filePath);
  assert.equal(restarted.get('received').state, OPERATION_STATES.RECEIVED);
  assert.equal(restarted.get('queued').state, OPERATION_STATES.QUEUED);
  await restarted.close();
});

test('ignores only a crash-truncated final append and rejects malformed complete records', async (t) => {
  const filePath = await fixture(t);
  const digest = sha256Payload({});
  const received = JSON.stringify({
    version: 1,
    operationId: 'safe',
    state: OPERATION_STATES.RECEIVED,
    at: '2026-08-02T00:00:00.000Z',
    payloadSha256: digest,
  });
  await writeFile(filePath, `${received}\n{"version":1`, { mode: 0o600 });

  const recovered = await OperationJournal.open(filePath);
  assert.equal(recovered.get('safe').state, OPERATION_STATES.RECEIVED);
  await recovered.markQueued('safe');
  await recovered.close();

  const afterAppend = await OperationJournal.open(filePath);
  assert.equal(afterAppend.get('safe').state, OPERATION_STATES.QUEUED);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /\{"version":1\{"version":1/);
  await afterAppend.close();

  await writeFile(filePath, `${received}\nnot-json\n`, { mode: 0o600 });
  await assert.rejects(OperationJournal.open(filePath), rejectsWithCode('JOURNAL_CORRUPT'));
});

test('rejects journal records containing raw argument fields', async (t) => {
  const filePath = await fixture(t);
  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 1,
      operationId: 'unsafe',
      state: OPERATION_STATES.RECEIVED,
      at: '2026-08-02T00:00:00.000Z',
      payloadSha256: sha256Payload({ secret: true }),
      arguments: { secret: true },
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(OperationJournal.open(filePath), rejectsWithCode('JOURNAL_UNSAFE_RECORD'));
});

test('accepts a precomputed digest and rejects writes after close', async (t) => {
  const filePath = await fixture(t);
  const journal = await OperationJournal.open(filePath);
  const digest = sha256Payload({ tool: 'editor_status' });
  await journal.recordReceived({ operationId: 'op-digest', payloadSha256: digest });
  await journal.close();

  assert.equal(journal.get('op-digest').payloadSha256, digest);
  await assert.rejects(journal.markQueued('op-digest'), rejectsWithCode('JOURNAL_CLOSED'));
});

test('durably resolves an UNKNOWN_OUTCOME only with an explicit safe resolution', async (t) => {
  const file = await fixture(t);
  const journal = await OperationJournal.open(file);
  await journal.recordReceived({ operationId: 'op-resolve', project: 'A', method: 'eval', payload: {} });
  await journal.markQueued('op-resolve');
  await journal.markDispatching('op-resolve');
  await journal.markUnknownOutcome('op-resolve');
  await assert.rejects(() => journal.markResolved('op-resolve', 'guess'), { code: 'JOURNAL_INVALID_INPUT' });
  await journal.markResolved('op-resolve', 'safe_to_retry');
  await journal.close();

  const reopened = await OperationJournal.open(file);
  assert.equal(reopened.get('op-resolve').state, OPERATION_STATES.RESOLVED);
  assert.equal(reopened.get('op-resolve').resolution, 'safe_to_retry');
  await reopened.close();
});

test('persists a machine-readable UNKNOWN_OUTCOME reason across restart', async (t) => {
  const file = await fixture(t);
  const journal = await OperationJournal.open(file);
  await journal.recordReceived({ operationId: 'op-timeout', project: 'A', method: 'build', payload: {} });
  await journal.markQueued('op-timeout');
  await journal.markDispatching('op-timeout');
  await journal.markUnknownOutcome('op-timeout', 'UNITY_MAIN_THREAD_TIMEOUT');
  await journal.close();

  const reopened = await OperationJournal.open(file);
  assert.equal(reopened.get('op-timeout').state, OPERATION_STATES.UNKNOWN_OUTCOME);
  assert.equal(reopened.get('op-timeout').reasonCode, 'UNITY_MAIN_THREAD_TIMEOUT');
  await reopened.close();

  const persisted = await readFile(file, 'utf8');
  assert.match(persisted, /"reasonCode":"UNITY_MAIN_THREAD_TIMEOUT"/);
});

test('rejects unsafe UNKNOWN_OUTCOME reason codes', async (t) => {
  const file = await fixture(t);
  const journal = await OperationJournal.open(file);
  await journal.recordReceived({ operationId: 'op-invalid-reason', payload: {} });
  await journal.markQueued('op-invalid-reason');
  await journal.markDispatching('op-invalid-reason');
  await assert.rejects(
    async () => journal.markUnknownOutcome('op-invalid-reason', 'not safe'),
    rejectsWithCode('JOURNAL_INVALID_INPUT'),
  );
  await journal.close();
});

test('persists a tracked background operation as RUNNING across restart', async (t) => {
  const file = await fixture(t);
  const journal = await OperationJournal.open(file);
  await journal.recordReceived({ operationId: 'op-build', project: 'A', method: 'build', payload: {} });
  await journal.markQueued('op-build');
  await journal.markDispatching('op-build');
  await journal.markRunning('op-build', 'build_status', { buildId: 'build-123' });
  await journal.close();

  const reopened = await OperationJournal.open(file);
  assert.equal(reopened.get('op-build').state, OPERATION_STATES.RUNNING);
  assert.equal(reopened.get('op-build').statusTool, 'build_status');
  assert.deepEqual(reopened.get('op-build').correlation, { buildId: 'build-123' });
  await reopened.markCompleted('op-build');
  await reopened.close();
});
