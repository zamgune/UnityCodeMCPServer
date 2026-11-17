import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BrokerCore } from '../../lib/broker-core.mjs';
import { normalizeConfig } from '../../lib/config.mjs';
import { readRouterOperationMeta } from '../../lib/mcp-protocol.mjs';
import { OperationJournal } from '../../lib/operation-journal.mjs';

const FAKE_UNITY = fileURLToPath(new URL('../fixtures/fake-unity.mjs', import.meta.url));
async function waitUntil(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for fake Pipeline state');
}

async function fixture(t, recovered = null) {
  const root = await mkdtemp(path.join(tmpdir(), 'pipeline-1-broker-'));
  const projectPath = path.join(root, 'A');
  await mkdir(path.join(projectPath, 'Assets'), { recursive: true });
  await mkdir(path.join(projectPath, 'ProjectSettings'));
  const stateFile = path.join(root, 'events.jsonl');
  const config = normalizeConfig({
    schemaVersion: 2, unityBin: process.execPath, unityArgs: [FAKE_UNITY],
    defaultProject: 'A', projects: [{ name: 'A', path: projectPath }], reauthIntervalMin: 0,
    license: { mode: 'floating', maxConcurrentEditors: 2 },
    broker: { socketPath: path.join(root, 'run', 'broker.sock'), journalFile: path.join(root, 'operations.jsonl'),
      workspaceLeaseFile: path.join(root, 'workspace.json'), adminTokenFile: path.join(root, 'admin-token'),
      processAuditEnforcement: 'report-only', childIdleMin: 0 },
  }, { cwd: root, homeDir: root });
  let journal = await OperationJournal.open(config.broker.journalFile);
  if (recovered) {
    await journal.recordReceived({ operationId: 'recovered', project: 'A', projectKey: config.projects[0].key,
      method: recovered.trigger, payload: {} });
    await journal.markQueued('recovered');
    await journal.markDispatching('recovered');
    await journal.markRunning('recovered', recovered.status, recovered.correlation);
    await journal.close();
    journal = await OperationJournal.open(config.broker.journalFile);
    const statusFile = `${stateFile}.${Buffer.from(projectPath).toString('hex').slice(-24)}.async.json`;
    await writeFile(statusFile, JSON.stringify({ status: 'completed', failed: false, errors: [], ...recovered.correlation }));
  }
  const core = new BrokerCore({ config, journal, toolRefreshIntervalMs: 0,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: stateFile, FAKE_UNITY_VERSION: '1.0.1', FAKE_UNITY_GROUPED: '1' },
    processAuditor: async () => ({ ok: true, findings: [], editors: [] }),
  });
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const messages = [];
  core.attach({ clientId: 'test', sessionNonce: 'session', defaultProject: 'A', clientKind: 'unit-test',
    send: (message) => messages.push(message) });
  let nextId = 1;
  const request = async (method, params = {}, ack = true) => {
    const id = nextId++;
    await core.handle('test', { jsonrpc: '2.0', id, method, params });
    const index = messages.findIndex((message) => message.id === id);
    assert.ok(index >= 0, `missing response ${id}`);
    const response = messages.splice(index, 1)[0];
    const meta = readRouterOperationMeta(response.result);
    if (ack && meta?.routerDeliveryAckRequired) {
      await core.acknowledgeResponse('test', { operationId: meta.routerOperationId, requestId: id });
    }
    return response;
  };
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await core.handle('test', { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  return { core, journal, messages, request, stateFile,
    call: (name, args = {}, ack = true) => request('tools/call', { name, arguments: args }, ack),
    events: async () => (await readFile(stateFile, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Pipeline 1 async test keeps leases, permits reads/cancel, and forwards kebab args unchanged', async (t) => {
  const h = await fixture(t);
  const catalog = await h.request('tools/list');
  assert.ok(catalog.result.tools.some((tool) => tool.name === 'test_run'));
  assert.ok(!catalog.result.tools.some((tool) => tool.name === 'run_tests'));
  const args = { 'async-tests': true, delayMs: 10_000, marker: 'test-once' };
  const started = await h.call('test_run', args);
  const id = readRouterOperationMeta(started.result).routerOperationId;
  assert.equal(h.journal.get(id).state, 'RUNNING');
  assert.ok(h.core.leases.list().length > 0);
  const read = await h.call('console_get');
  assert.notEqual(read.result?.isError, true);
  const cancelled = await h.call('test_cancel');
  assert.equal(cancelled.result.structuredContent.status, 'cancelled');
  await waitUntil(() => h.journal.get(id).state === 'COMPLETED');
  assert.equal(h.core.asyncByProject.size, 0);
  assert.equal(h.core.leases.list().length, 0);
  const calls = (await h.events()).filter((event) => event.kind === 'call-start');
  assert.deepEqual(calls.filter((event) => event.wireName === 'test_run').map((event) => event.arguments), [args]);
  assert.equal(calls.filter((event) => event.wireName === 'test_cancel').length, 1);
});

test('Pipeline 1 recompile announces one catalog refresh after synchronous or async success', async (t) => {
  for (const mode of ['sync_success', 'async_success', 'failed']) {
    await t.test(mode, async (t) => {
      const h = await fixture(t);
      await h.request('tools/list');
      h.messages.length = 0;
      const reply = await h.call('script_recompile', { mode, delayMs: 40 });
      const id = readRouterOperationMeta(reply.result).routerOperationId;
      await waitUntil(() => h.journal.get(id).state === 'COMPLETED');
      assert.equal(h.core.leases.list().length, 0);
      const changed = h.messages.filter((message) => message.method === 'notifications/tools/list_changed');
      assert.equal(changed.length, mode === 'failed' ? 0 : 1);
      const calls = (await h.events()).filter((event) => event.kind === 'call-start');
      assert.equal(calls.filter((event) => event.wireName === 'script_recompile').length, 1);
      if (mode === 'async_success') assert.ok(calls.some((event) => event.wireName === 'script_recompile_status'));
    });
  }
});

test('modern build holds resources through terminal status until the trigger delivery is acknowledged', async (t) => {
  const h = await fixture(t);
  const reply = await h.call('build_run', { confirm: true, delayMs: 40 }, false);
  const id = readRouterOperationMeta(reply.result).routerOperationId;
  await waitUntil(() => h.core.asyncByProject.values().next().value?.terminalObserved);
  assert.equal(h.journal.get(id).state, 'RUNNING');
  assert.ok(h.core.leases.list().length > 0);
  await h.core.acknowledgeResponse('test', { operationId: id, requestId: reply.id });
  await waitUntil(() => h.journal.get(id).state === 'COMPLETED');
  assert.equal(h.core.leases.list().length, 0);
});

test('recovered modern jobs poll their exact status without replay and retain uncertain-delivery fences', async (t) => {
  for (const recovered of [
    { trigger: 'test_run', status: 'test_status' },
    { trigger: 'script_recompile', status: 'script_recompile_status' },
    { trigger: 'build_run', status: 'build_status', correlation: { buildId: 'original-build' } },
  ]) {
    await t.test(recovered.trigger, async (t) => {
      const h = await fixture(t, recovered);
      await waitUntil(() => h.journal.get('recovered').state === 'UNKNOWN_OUTCOME');
      assert.equal(h.core.recoveryFaults.size, 0);
      assert.equal(h.core.asyncByProject.size, 0);
      assert.ok(h.core.unknownByProject.size > 0);
      const calls = (await h.events()).filter((event) => event.kind === 'call-start');
      assert.ok(calls.some((event) => event.wireName === recovered.status));
      assert.equal(calls.filter((event) => event.wireName === recovered.trigger).length, 0);
    });
  }
});
