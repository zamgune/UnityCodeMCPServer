import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { UnityMcpChild } from '../../lib/unity-child.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_UNITY = path.join(ROOT, 'test/fixtures/fake-unity.mjs');

test('rejects a project access gate before spawning a Unity child', async () => {
  let gateCalls = 0;
  const child = new UnityMcpChild({
    project: { id: 'blocked', name: 'blocked', path: ROOT },
    unityBin: '/definitely/not/a/unity/binary',
    beforeSpawn: async () => {
      gateCalls += 1;
      const error = new Error('project access blocked');
      error.code = 'PROJECT_ACCESS_DENIED';
      error.details = { responsibleExecutable: process.execPath };
      throw error;
    },
  });
  await assert.rejects(
    () => child.start(),
    (error) => error.code === 'PROJECT_ACCESS_DENIED'
      && error.details.responsibleExecutable === process.execPath,
  );
  assert.equal(gateCalls, 1);
  assert.equal(child.snapshot().state, 'OFFLINE');
  assert.equal(child.snapshot().pid, null);
});

test('shares one project access gate across concurrent starts', async (t) => {
  let gateCalls = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const child = new UnityMcpChild({
    project: { id: 'shared-gate', name: 'shared-gate', path: ROOT },
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    startupTimeoutMs: 3_000,
    env: { ...process.env, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    beforeSpawn: async () => { gateCalls += 1; await gate; },
  });
  t.after(() => child.stop());
  const first = child.start();
  const second = child.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(gateCalls, 1);
  releaseGate();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(gateCalls, 1);
  assert.equal(child.snapshot().ready, true);
});

test('counts project access gate time against the startup deadline', async () => {
  const child = new UnityMcpChild({
    project: { id: 'slow-gate', name: 'slow-gate', path: ROOT },
    unityBin: '/definitely/not/a/unity/binary',
    startupTimeoutMs: 20,
    beforeSpawn: () => new Promise((resolve) => setTimeout(resolve, 40)),
  });
  await assert.rejects(() => child.start(), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(child.snapshot().pid, null);
});

test('invalid child framing fails the active request promptly and quarantines the child', async (t) => {
  const child = new UnityMcpChild({
    project: { id: 'fake', name: 'fake', path: ROOT },
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    startupTimeoutMs: 3_000,
    toolTimeoutMs: 10_000,
    env: { ...process.env, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
  });
  t.after(() => child.stop());
  await child.start();
  const startedAt = Date.now();
  const response = await child.request('tools/call', {
    name: 'editor_status',
    arguments: { malformedFrame: true },
  });
  assert.equal(response.transportFailure, true);
  assert.equal(response.dispatched, true);
  assert(Date.now() - startedAt < 2_000, 'corrupt framing must not wait for the tool timeout');
});

test('reports each child process lifecycle once and distinguishes expected stop', async (t) => {
  const events = [];
  const child = new UnityMcpChild({
    project: { id: 'fake-lifecycle', name: 'fake-lifecycle', path: ROOT },
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    startupTimeoutMs: 3_000,
    toolTimeoutMs: 3_000,
    env: { ...process.env, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    onLifecycle: (event) => events.push(event),
  });
  t.after(() => child.stop());

  await child.start();
  const failed = await child.request('tools/call', {
    name: 'editor_status',
    arguments: { failOnce: `lifecycle-${process.pid}-${Date.now()}` },
  });
  assert.equal(failed.transportFailure, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.length, 1);
  assert.equal(events[0].expected, false);
  assert.equal(events[0].processGeneration, 1);

  await child.start();
  await child.stop('idle');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(events.length, 2);
  assert.equal(events[1].expected, true);
  assert.equal(events[1].expectedReason, 'idle');
  assert.equal(events[1].processGeneration, 2);
});

test('audited dispatch never auto-restarts a child that stopped after the audit', async (t) => {
  let spawnGates = 0;
  const child = new UnityMcpChild({
    project: { id: 'audited-dispatch', name: 'audited-dispatch', path: ROOT },
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    startupTimeoutMs: 3_000,
    toolTimeoutMs: 3_000,
    env: { ...process.env, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    beforeSpawn: async () => { spawnGates += 1; },
  });
  t.after(() => child.stop());

  await child.start();
  await child.stop('tool-retry');
  const response = await child.request('tools/call', {
    name: 'editor_status',
    arguments: {},
  }, 3_000, {
    protocolVersion: '2025-06-18',
    requireAlreadyStarted: true,
  });

  assert.equal(response.transportFailure, true);
  assert.equal(response.dispatched, false);
  assert.equal(spawnGates, 1);
  assert.equal(child.snapshot().alive, false);
});

test('fails closed when the official child negotiates a different MCP revision', async (t) => {
  const child = new UnityMcpChild({
    project: { id: 'fake-protocol', name: 'fake-protocol', path: ROOT },
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    startupTimeoutMs: 3_000,
    toolTimeoutMs: 3_000,
    env: {
      ...process.env,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_PROTOCOL_VERSION: '2025-11-25',
    },
  });
  t.after(() => child.stop());
  await assert.rejects(() => child.start(), /negotiated unsupported protocol 2025-11-25/);
  assert.equal(child.alive, false);
  assert.equal(child.snapshot().protocolVersion, null);
});
