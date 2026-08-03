import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCleanActiveRecompile,
  assertCompletedReloadOperation,
  assertEditorReady,
  assertCleanRouterState,
  assertCleanTerminal,
  classifyReloadDispatch,
  assertNoopDispatch,
  assertNotificationPolicy,
  assertStableProcesses,
  assertTrackedReloadTrigger,
  CanaryPolicyError,
  editorObservation,
  parseCanaryArgs,
  recompileObservation,
  runCanary,
  STABLE_ADAPTER_PATH,
  waitForToolCatalog,
} from '../../scripts/live-canary.mjs';

function toolResponse(value) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

function cleanStatus() {
  return {
    broker: { pid: 401, draining: false },
    unity: { version: '1.0.0-beta.3' },
    budget: { pendingTotal: 0, activeHeavy: 0 },
    leases: [],
    workspaceLeases: [],
    workspaceStore: { ok: true },
    unknownOutcomes: [],
    recoveryFaults: [],
    processAudit: { ok: true },
    projectAccess: { ok: true },
    projects: [{
      name: 'Project A',
      aliases: ['a'],
      child: { pid: 402, alive: true, ready: true },
      scheduler: {
        pending: 0,
        queued: 0,
        activeOperationId: null,
        activeClientId: null,
      },
      mutationFence: [],
      backgroundOperation: null,
      deliveryPending: [],
    }],
  };
}

const cleanDoctor = { ok: true, processAudit: { ok: true }, projectAccess: { ok: true } };

test('argument policy requires an explicit project and mode with bounded values', () => {
  assert.throws(() => parseCanaryArgs([]), /--project is required/);
  assert.throws(() => parseCanaryArgs(['--project', 'a']), /--mode must be noop or reload/);
  assert.throws(() => parseCanaryArgs(['--project', 'a', '--mode', 'write']), /noop or reload/);
  assert.throws(() => parseCanaryArgs(['--project', 'a', '--mode', 'noop', '--adapter', 'relative']), /absolute/);
  assert.throws(() => parseCanaryArgs(['--project', 'a', '--mode', 'noop', '--timeout-sec', '4']), /between 5 and 600/);
  assert.throws(() => parseCanaryArgs(['--project', 'a', '--mode', 'noop', '--project', 'b']), /only once/);

  const parsed = parseCanaryArgs([
    '--project', 'a', '--mode', 'reload', '--timeout-sec', '90', '--settle-ms', '500', '--dry-run',
  ]);
  assert.equal(parsed.project, 'a');
  assert.equal(parsed.mode, 'reload');
  assert.equal(parsed.adapter, STABLE_ADAPTER_PATH);
  assert.equal(parsed.timeoutSec, 90);
  assert.equal(parsed.settleMs, 500);
  assert.equal(parsed.dryRun, true);
});

test('help and dry-run return before constructing any stdio client', async () => {
  let factoryCalls = 0;
  let stdout = '';
  const runtime = {
    clientFactory: () => { factoryCalls += 1; throw new Error('must not connect'); },
    io: { stdout: { write: (value) => { stdout += value; } }, stderr: { write() {} } },
  };
  assert.equal((await runCanary(parseCanaryArgs(['--help']), runtime)).kind, 'help');
  assert.equal((await runCanary(parseCanaryArgs([
    '--project', 'a', '--mode', 'noop', '--dry-run',
  ]), runtime)).kind, 'dry-run');
  assert.equal(factoryCalls, 0);
  assert.match(stdout, /mutationDispatches/);
});

test('noop terminal policy accepts only clean up_to_date', () => {
  assert.equal(assertNoopDispatch(recompileObservation(toolResponse({
    status: 'up_to_date', message: 'No scripts needed recompilation.',
  }))).status, 'up_to_date');
  assert.throws(() => assertNoopDispatch(recompileObservation(toolResponse({
    status: 'compiling', message: 'Compilation started.',
  }))), /must be up_to_date/);
  const clean = recompileObservation(toolResponse({
    status: 'up_to_date', failed: false, errors: [], isCompiling: false,
  }));
  assert.equal(assertCleanTerminal(clean, 'noop').status, 'up_to_date');
  for (const dirty of [
    { status: 'completed', failed: false, errors: [], isCompiling: false },
    { status: 'up_to_date', failed: true, errors: [], isCompiling: false },
    { status: 'up_to_date', failed: false, errors: ['CS1002'], isCompiling: false },
    { status: 'up_to_date', failed: false, errors: [], isCompiling: true },
  ]) assert.throws(() => assertCleanTerminal(recompileObservation(toolResponse(dirty)), 'noop'), CanaryPolicyError);
});

test('reload terminal policy rejects active, failed, and ambiguous evidence', () => {
  const clean = recompileObservation(toolResponse({
    status: 'completed', failed: false, errors: [], isCompiling: false,
  }));
  assert.equal(assertCleanTerminal(clean, 'reload').status, 'completed');
  assert.throws(() => assertCleanTerminal(recompileObservation(toolResponse({
    status: 'compiling', failed: false, errors: [], isCompiling: true,
  })), 'reload'), /requires terminal completed/);
  assert.throws(() => recompileObservation(toolResponse({
    first: { status: 'completed', failed: false, errors: [], isCompiling: false },
    second: { status: 'failed', failed: true, errors: ['error'], isCompiling: false },
  })), /unambiguous/);
  assert.throws(() => recompileObservation({ result: { isError: true } }), /returned an error/);
});

test('active reload policy rejects dirty and semantically inconsistent polls', () => {
  assert.equal(assertCleanActiveRecompile({
    status: 'triggered', failed: false, errors: [], isCompiling: false,
  }).status, 'triggered');
  assert.equal(assertCleanActiveRecompile({
    status: 'compiling', failed: false, errors: [], isCompiling: true,
  }).status, 'compiling');
  for (const dirty of [
    { status: 'triggered', failed: false, errors: [], isCompiling: true },
    { status: 'compiling', failed: false, errors: [], isCompiling: false },
    { status: 'compiling', failed: true, errors: [], isCompiling: true },
    { status: 'triggered', failed: false, errors: ['CS1002'], isCompiling: false },
    { status: 'completed', failed: false, errors: [], isCompiling: false },
  ]) assert.throws(() => assertCleanActiveRecompile(dirty), CanaryPolicyError);
});

test('editor readiness requires exact idle state and project identity', () => {
  const ready = editorObservation(toolResponse({
    status: 'ready',
    compiling: false,
    domainReloadInProgress: false,
    playMode: 'stopped',
    projectPath: '/project/a',
    unityVersion: '6000.3.17f1',
  }));
  assert.equal(assertEditorReady(ready, '/project/a').status, 'ready');
  for (const mutate of [
    (value) => { value.status = 'compiling'; value.compiling = true; },
    (value) => { value.domainReloadInProgress = true; value.status = 'reloading'; },
    (value) => { value.playMode = 'playing'; value.status = 'playing'; },
    (value) => { value.projectPath = '/project/b'; },
  ]) {
    const dirty = { ...ready };
    mutate(dirty);
    assert.throws(() => assertEditorReady(dirty, '/project/a'), /not mutation-ready/);
  }
});

test('reload trigger requires active clean status and complete router tracking metadata', () => {
  const tracked = {
    status: 'triggered',
    failed: false,
    errors: [],
    isCompiling: false,
    routerOperationState: 'RUNNING',
    routerOperationId: 'reload-op',
    routerDeliveryAckRequired: true,
    statusTool: 'recompile_status',
  };
  assert.equal(assertTrackedReloadTrigger(toolResponse(tracked)), 'reload-op');
  for (const mutate of [
    (value) => { value.status = 'completed'; },
    (value) => { value.routerOperationState = 'COMPLETED'; },
    (value) => { delete value.routerOperationId; },
    (value) => { value.routerDeliveryAckRequired = false; },
    (value) => { value.statusTool = 'other_status'; },
    (value) => { value.isCompiling = true; },
  ]) {
    const invalid = structuredClone(tracked);
    mutate(invalid);
    assert.throws(() => assertTrackedReloadTrigger(toolResponse(invalid)), CanaryPolicyError);
  }
  assert.equal(assertTrackedReloadTrigger(toolResponse({
    ...tracked, status: 'compiling', isCompiling: true,
  })), 'reload-op');
});

test('reload dispatch accepts an exact synchronous clean completion contract', () => {
  const synchronous = {
    status: 'completed',
    failed: false,
    errors: [],
    isCompiling: false,
    routerOperationState: 'COMPLETED',
    routerOperationId: 'reload-sync',
    routerDeliveryAckRequired: true,
  };
  const accepted = classifyReloadDispatch(toolResponse(synchronous));
  assert.equal(accepted.kind, 'synchronous');
  assert.equal(accepted.operationId, 'reload-sync');
  assert.equal(accepted.requireStatusTool, false);

  for (const mutate of [
    (value) => { value.failed = true; },
    (value) => { value.errors = ['CS1002']; },
    (value) => { value.isCompiling = true; },
    (value) => { value.routerOperationState = 'RUNNING'; },
    (value) => { delete value.routerOperationId; },
    (value) => { value.routerDeliveryAckRequired = false; },
    (value) => { value.statusTool = 'recompile_status'; },
    (value) => { value.statusTool = 'build_status'; },
  ]) {
    const invalid = structuredClone(synchronous);
    mutate(invalid);
    assert.throws(() => classifyReloadDispatch(toolResponse(invalid)), CanaryPolicyError);
  }
});

test('reload operation closeout accepts only the same COMPLETED journal record', () => {
  const completed = {
    operationId: 'reload-op',
    method: 'recompile',
    statusTool: 'recompile_status',
    state: 'COMPLETED',
  };
  assert.equal(assertCompletedReloadOperation(completed, 'reload-op').state, 'COMPLETED');
  for (const invalid of [
    { ...completed, operationId: 'other' },
    { ...completed, method: 'build' },
    { ...completed, statusTool: 'build_status' },
    { ...completed, state: 'UNKNOWN_OUTCOME' },
    { ...completed, state: 'CANCELLED' },
  ]) assert.throws(() => assertCompletedReloadOperation(invalid, 'reload-op'), CanaryPolicyError);

  const synchronous = { operationId: 'reload-sync', method: 'recompile', state: 'COMPLETED' };
  assert.equal(assertCompletedReloadOperation(
    synchronous,
    'reload-sync',
    { requireStatusTool: false },
  ).state, 'COMPLETED');
  assert.throws(() => assertCompletedReloadOperation(
    { ...synchronous, statusTool: 'recompile_status' },
    'reload-sync',
    { requireStatusTool: false },
  ), CanaryPolicyError);
  assert.throws(() => assertCompletedReloadOperation(
    { ...synchronous, statusTool: 'build_status' },
    'reload-sync',
    { requireStatusTool: false },
  ), CanaryPolicyError);
});

test('notification policy is exact per same-project original client', () => {
  assert.equal(assertNotificationPolicy('noop', { clientA: 0, clientB: 0 }), true);
  assert.equal(assertNotificationPolicy('reload', { clientA: 1, clientB: 1 }), true);
  assert.throws(() => assertNotificationPolicy('noop', { clientA: 1, clientB: 0 }), /clientA/);
  assert.throws(() => assertNotificationPolicy('reload', { clientA: 1, clientB: 2 }), /clientB/);
});

test('catalog recovery waits through a transient management-only list and fails closed at its deadline', async () => {
  const full = {
    result: {
      tools: [
        { name: 'editor_status', inputSchema: { type: 'object', properties: {} } },
        { name: 'unity_router_status', inputSchema: { type: 'object', properties: {} } },
      ],
    },
  };
  const managementOnly = {
    result: {
      tools: [{ name: 'unity_router_status', inputSchema: { type: 'object', properties: {} } }],
    },
  };
  const recovering = {
    error: {
      code: -32080,
      message: 'catalog recovering',
      data: { brokerCode: 'TOOL_CATALOG_RECOVERING' },
    },
  };
  const expected = JSON.stringify([...full.result.tools].sort((left, right) => left.name.localeCompare(right.name)));
  const responses = [recovering, managementOnly, full];
  const client = { request: async () => responses.shift() ?? full };
  assert.equal(await waitForToolCatalog(client, expected, Date.now() + 1_000, { pollMs: 1 }), full);

  await assert.rejects(
    waitForToolCatalog(
      { request: async () => managementOnly },
      expected,
      Date.now() + 20,
      { label: 'stuck client', pollMs: 1 },
    ),
    /stuck client tool catalog did not recover/,
  );
  await assert.rejects(
    waitForToolCatalog(
      { request: async () => ({ result: { tools: [{ name: 'broken', inputSchema: null }] } }) },
      expected,
      Date.now() + 1_000,
      { label: 'malformed client', pollMs: 1 },
    ),
    /invalid or duplicate tool names/,
  );
});

test('clean closeout requires idle schedulers, empty leases/fences, and passing audits', () => {
  const target = assertCleanRouterState(cleanStatus(), cleanDoctor, 'a');
  assert.equal(target.child.pid, 402);

  const cases = [
    (value) => { value.budget.pendingTotal = 1; },
    (value) => { value.leases.push({ key: 'source-refresh' }); },
    (value) => { value.projects[0].scheduler.activeOperationId = 'op'; },
    (value) => { value.projects[0].mutationFence.push('unknown-op'); },
    (value) => { value.projects[0].deliveryPending.push('op'); },
    (value) => { value.processAudit.ok = false; },
    (value) => { value.projectAccess.ok = false; },
  ];
  for (const mutate of cases) {
    const dirty = structuredClone(cleanStatus());
    mutate(dirty);
    assert.throws(() => assertCleanRouterState(dirty, cleanDoctor, 'a'), CanaryPolicyError);
  }
  assert.throws(() => assertCleanRouterState(cleanStatus(), { ...cleanDoctor, ok: false }, 'a'), /doctor audit/);
});

test('process identity policy is observation-based and never hardcodes a PID', () => {
  assert.equal(assertStableProcesses(
    { brokerPid: 9001, childPid: 9002 },
    { brokerPid: 9001, childPid: 9002 },
  ), true);
  assert.throws(() => assertStableProcesses(
    { brokerPid: 9001, childPid: 9002 },
    { brokerPid: 9003, childPid: 9002 },
  ), /broker changed/);
  assert.throws(() => assertStableProcesses(
    { brokerPid: 9001, childPid: 9002 },
    { brokerPid: 9001, childPid: 9004 },
  ), /Unity child changed/);
  assert.equal(assertStableProcesses(
    { brokerPid: 9001, childPid: 9002 },
    { brokerPid: 9001, childPid: 9004 },
    { requireSameChild: false },
  ), true);
});
