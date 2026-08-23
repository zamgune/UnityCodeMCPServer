import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BrokerCore,
  ambiguousUnityExecutionTimeout,
  assertExactUnityProjectInfo,
  catalogProvesToolAbsent,
  isValidToolCatalog,
} from '../../lib/broker-core.mjs';
import { normalizeConfig } from '../../lib/config.mjs';
import { readRouterOperationMeta } from '../../lib/mcp-protocol.mjs';
import { OperationJournal } from '../../lib/operation-journal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_UNITY = path.join(ROOT, 'test/fixtures/fake-unity.mjs');

test('Unity project-info preflight accepts only the exact configured Hub path', () => {
  assert.deepEqual(
    assertExactUnityProjectInfo(JSON.stringify({
      success: true,
      data: { path: '/Volumes/Work/Game' },
    }), '/Volumes/Work/Game'),
    {
      expectedProjectPath: '/Volumes/Work/Game',
      observedProjectPath: '/Volumes/Work/Game',
    },
  );
  assert.throws(
    () => assertExactUnityProjectInfo(JSON.stringify({
      success: true,
      data: { path: '/Users/dev/GameAlias' },
    }), '/Volumes/Work/Game'),
    { code: 'UNITY_HUB_PROJECT_PATH_MISMATCH' },
  );
  assert.throws(
    () => assertExactUnityProjectInfo('{not-json', '/Volumes/Work/Game'),
    { code: 'UNITY_HUB_PROJECT_INFO_INVALID' },
  );
});

test('lifecycle catalog absence proof requires one complete non-empty valid catalog', () => {
  const editorStatus = {
    name: 'editor_status',
    inputSchema: { type: 'object', properties: {} },
  };
  const typedStatus = {
    name: 'zamgune_handoff_status',
    inputSchema: { type: 'object', properties: {} },
  };
  const missing = { result: { tools: [editorStatus] } };
  const stable = {
    processGenerationBefore: 3,
    processGenerationAfter: 3,
    invalidationEpochBefore: 7,
    invalidationEpochAfter: 7,
  };

  assert.equal(catalogProvesToolAbsent(missing, 'zamgune_handoff_status', stable), true);
  assert.equal(catalogProvesToolAbsent({ result: { tools: [editorStatus, typedStatus] } },
    'zamgune_handoff_status', stable), false);
  assert.equal(catalogProvesToolAbsent({ result: { tools: [] } }, 'zamgune_handoff_status', stable), false);
  assert.equal(catalogProvesToolAbsent({ result: { tools: [{}] } }, 'zamgune_handoff_status', stable), false);
  assert.equal(catalogProvesToolAbsent({ result: { tools: [editorStatus], nextCursor: 'more' } },
    'zamgune_handoff_status', stable), false);
  assert.equal(catalogProvesToolAbsent({ error: { code: -32000 } }, 'zamgune_handoff_status', stable), false);
  assert.equal(catalogProvesToolAbsent({ transportFailure: true, result: missing.result },
    'zamgune_handoff_status', stable), false);
  assert.equal(catalogProvesToolAbsent(missing, 'zamgune_handoff_status', {
    ...stable, processGenerationAfter: 4,
  }), false);
  assert.equal(catalogProvesToolAbsent(missing, 'zamgune_handoff_status', {
    ...stable, invalidationEpochAfter: 8,
  }), false);
});

async function fixture(t, {
  projects = ['A'],
  processAuditEnforcement = 'enforce',
  license = { mode: 'floating', maxConcurrentEditors: 2 },
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'broker-core-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const name of projects) {
    const projectPath = path.join(root, name);
    await mkdir(path.join(projectPath, 'Assets'), { recursive: true });
    await mkdir(path.join(projectPath, 'ProjectSettings'));
    entries.push({ name, path: projectPath });
  }
  const config = normalizeConfig({
    schemaVersion: 2,
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    minimumCliVersion: '1.0.0-beta.3',
    defaultProject: projects[0],
    projects: entries,
    reauthIntervalMin: 0,
    queue: { maxPendingPerClient: 8, maxPendingPerProject: 16, maxPendingTotal: 32, maxHeavyInFlight: 1, deadlineSec: 3 },
    license,
    broker: {
      socketPath: path.join(root, 'run', 'broker.sock'),
      journalFile: path.join(root, 'operations.jsonl'),
      workspaceLeaseFile: path.join(root, 'workspace.json'),
      adminTokenFile: path.join(root, 'admin-token'),
      processAuditEnforcement,
      childIdleMin: 0,
    },
  }, { cwd: root, homeDir: root });
  return { root, config, stateFile: path.join(root, 'events.jsonl') };
}

function attach(core, defaultProject, { clientId = `client-${defaultProject}`, isAdmin = false } = {}) {
  const messages = [];
  core.attach({
    clientId,
    sessionNonce: `session-${clientId}`,
    defaultProject,
    clientKind: 'unit-test',
    isAdmin,
    send: (message) => messages.push(message),
  });
  return {
    clientId,
    messages,
    async request(id, method, params = {}) {
      await core.handle(clientId, { jsonrpc: '2.0', id, method, params });
      const index = messages.findIndex((message) => message.id === id);
      assert(index >= 0, `missing response ${id}`);
      const response = messages.splice(index, 1)[0];
      if (method === 'initialize' && response.result) {
        await core.handle(clientId, {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        });
      }
      return response;
    },
  };
}

const CLEAN_AUDIT = Object.freeze({ ok: true, findings: Object.freeze([]), editors: Object.freeze([]) });

test('tool catalog shape requires unique non-empty names and object input schemas', () => {
  const valid = { name: 'editor_status', description: 'status', inputSchema: { type: 'object' } };
  assert.equal(isValidToolCatalog([]), true);
  assert.equal(isValidToolCatalog([valid]), true);
  assert.equal(isValidToolCatalog(undefined), false);
  assert.equal(isValidToolCatalog([{}]), false);
  assert.equal(isValidToolCatalog([{ ...valid, name: '' }]), false);
  assert.equal(isValidToolCatalog([{ ...valid, inputSchema: null }]), false);
  assert.equal(isValidToolCatalog([valid, { ...valid }]), false);
  assert.equal(isValidToolCatalog([{ ...valid, outputSchema: [] }]), false);
});

test('main-thread timeout detection requires an error-shaped Unity response', () => {
  const errorResponse = {
    result: {
      content: [{ type: 'text', text: 'Main thread operation timed out after 60000ms' }],
      structuredContent: {
        ok: false,
        httpStatus: 400,
        message: 'Main thread operation timed out after 60000ms',
      },
      isError: true,
    },
  };
  assert.deepEqual(ambiguousUnityExecutionTimeout(errorResponse), {
    reasonCode: 'UNITY_MAIN_THREAD_TIMEOUT',
    timeoutMs: 60_000,
    httpStatus: 400,
  });
  assert.equal(ambiguousUnityExecutionTimeout({
    result: {
      content: errorResponse.result.content,
      structuredContent: { ok: true },
      isError: false,
    },
  }), null);
  assert.equal(ambiguousUnityExecutionTimeout({
    result: {
      content: [{ type: 'text', text: 'ordinary validation failed' }],
      isError: true,
    },
  }), null);
});

function controllableProjectAccessAuditor(config, { allowed = false } = {}) {
  const state = { allowed, assertCalls: 0, assertOptions: [], auditAllCalls: 0 };
  const resultFor = (project) => ({
    ok: state.allowed,
    code: state.allowed ? 'PROJECT_ACCESS_OK' : 'PROJECT_ACCESS_DENIED',
    project: project.name,
    projectKey: project.key,
    projectPath: project.path,
    checkedAt: new Date().toISOString(),
    likelyCause: state.allowed ? null : 'REMOVABLE_VOLUME_PRIVACY_DENIED',
    remediation: state.allowed ? null : 'Grant Removable Volumes access.',
    responsibleExecutable: process.execPath,
    details: {},
  });
  return {
    state,
    snapshot() {
      return {
        ok: state.allowed,
        responsibleExecutable: process.execPath,
        timeoutMs: 3_000,
        projects: config.projects.map((project) => ({ ...resultFor(project), stale: false })),
      };
    },
    async auditAll() {
      state.auditAllCalls += 1;
      const projects = config.projects.map(resultFor);
      return {
        ok: projects.every((project) => project.ok),
        responsibleExecutable: process.execPath,
        timeoutMs: 3_000,
        checkedAt: new Date().toISOString(),
        projects,
      };
    },
    async assertAccessible(project, options = {}) {
      state.assertCalls += 1;
      state.assertOptions.push(options);
      const result = resultFor(project);
      if (!result.ok) {
        const error = new Error('project access denied');
        error.code = result.code;
        error.details = result;
        throw error;
      }
      return result;
    },
    async close() {},
  };
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeEditorLifecycle(config) {
  const snapshots = new Map();
  const calls = [];
  return {
    calls,
    async ensureProject(project) {
      calls.push(project.key);
      const existing = [...snapshots.values()].find((entry) => entry.target.projectKey === project.key);
      if (existing) return existing;
      const value = Object.freeze({
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        target: Object.freeze({
          project: project.name,
          projectKey: project.key,
          projectPath: project.path,
        }),
        state: 'QUEUED',
        blockers: Object.freeze([]),
        mode: config.editorHandoff.mode,
      });
      snapshots.set(value.operationId, value);
      return value;
    },
    status(operationId) { return snapshots.get(operationId) ?? null; },
    complete(operationId) {
      const current = snapshots.get(operationId);
      if (!current) return null;
      const completed = Object.freeze({ ...current, state: 'COMPLETED' });
      snapshots.set(operationId, completed);
      return completed;
    },
    activeStatus() { return null; },
    close() {},
  };
}

test('editor use is admin-gated while status and workspace validation turns expose the tracked handoff', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const editorLifecycle = fakeEditorLifecycle(harness.config);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const ordinary = attach(core, 'A', { clientId: 'ordinary-editor-client' });
  const admin = attach(core, 'A', { clientId: 'admin-editor-client', isAdmin: true });
  for (const client of [ordinary, admin]) {
    await client.request(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
  }

  const denied = await ordinary.request(2, 'tools/call', {
    name: 'unity_router_editor_use', arguments: { project: 'A' },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.code, 'ADMIN_REQUIRED');

  const started = await admin.request(2, 'tools/call', {
    name: 'unity_router_editor_use', arguments: { project: 'A' },
  });
  const operationId = started.result.structuredContent.operationId;
  assert.equal(operationId, '123e4567-e89b-42d3-a456-426614174000');
  const observed = await ordinary.request(3, 'tools/call', {
    name: 'unity_router_editor_use_status', arguments: { operationId },
  });
  assert.equal(observed.result.structuredContent.target.project, 'A');

  const workspace = await ordinary.request(4, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  assert.equal(workspace.result.isError, undefined);
  assert.equal(workspace.result.structuredContent.editorUse.operationId, operationId);
  editorLifecycle.complete(operationId);
  const ended = await ordinary.request(5, 'tools/call', {
    name: 'unity_router_workspace_end',
    arguments: { leaseToken: workspace.result.structuredContent.token },
  });
  assert.equal(ended.result.isError, undefined);
  assert.equal(editorLifecycle.calls.length, 2);
});

test('confirmed parent Editor handoff resolution clears its internal open fence first', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const project = harness.config.projects[0];
  const operationId = '123e4567-e89b-42d3-a456-426614174099';
  const openOperationId = `${operationId}:open`;
  await journal.recordReceived({
    operationId,
    project: project.name,
    projectKey: project.key,
    method: 'unity_router_editor_use',
    payload: { projectKey: project.key },
  });
  await journal.markQueued(operationId);
  await journal.markDispatching(operationId);
  await journal.markUnknownOutcome(operationId);
  await journal.recordReceived({
    operationId: openOperationId,
    project: project.name,
    projectKey: project.key,
    method: 'unity_router_editor_open',
    payload: { parentOperationId: operationId, projectKey: project.key },
  });
  await journal.markQueued(openOperationId);
  await journal.markDispatching(openOperationId);
  await journal.markUnknownOutcome(openOperationId);

  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const admin = attach(core, 'A', { clientId: 'editor-resolution-admin', isAdmin: true });
  await admin.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const resolved = await admin.request(2, 'tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: { operationId, resolution: 'confirmed_completed' },
  });
  assert.equal(resolved.result.isError, undefined);
  assert.equal(resolved.result.structuredContent.operationId, operationId);
  assert.equal(resolved.result.structuredContent.state, 'RESOLVED');
  assert.equal(resolved.result.structuredContent.editorOpenResolution.operationId, openOperationId);
  assert.equal(resolved.result.structuredContent.editorOpenResolution.state, 'RESOLVED');
  assert.equal(journal.get(openOperationId).state, 'RESOLVED');
  assert.equal(journal.get(operationId).state, 'RESOLVED');
  assert.equal(core.unknownByProject.has(project.key), false);
});

test('single-seat inactive projects expose management tools without spawning a blind Unity MCP child', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'inactive-project-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const listed = await client.request(2, 'tools/list');
  assert(listed.result.tools.some((tool) => tool.name === 'unity_router_editor_use_status'));
  assert(!listed.result.tools.some((tool) => tool.name === 'editor_status'));
  const call = await client.request(3, 'tools/call', { name: 'editor_status', arguments: {} });
  assert.equal(call.result.isError, true);
  assert.equal(call.result.structuredContent.code, 'PROJECT_EDITOR_INACTIVE');
  assert.equal(core.children.size, 0);
});

test('single-seat inactive project remains fail-closed when unrelated audit findings make ok false', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    processAuditor: async () => ({
      ok: false,
      findings: [{ severity: 'error', kind: 'legacy_or_unattached_adapter', pid: 9001 }],
      editors: [],
    }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'inactive-audit-finding-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const listed = await client.request(2, 'tools/list');
  assert(!listed.result.tools.some((tool) => tool.name === 'editor_status'));
  const call = await client.request(3, 'tools/call', { name: 'editor_status', arguments: {} });
  assert.equal(call.result.structuredContent.code, 'EDITOR_PROCESS_AUDIT_UNSAFE');
  assert.equal(core.children.size, 0);
});

test('single-seat child gate rejects error findings even if process audit ok is inconsistent', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    processAuditor: async () => ({
      ok: true,
      findings: [{ severity: 'error', kind: 'duplicate_broker', pid: 9002 }],
      editors: [{ pid: 778, projectPath: harness.config.projects[0].path }],
    }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'inconsistent-audit-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const listed = await client.request(2, 'tools/list');
  assert.equal(listed.result, undefined);
  assert.equal(listed.error.data.brokerCode, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(listed.error.data.details.findings[0].kind, 'duplicate_broker');
  assert.equal(core.children.size, 0);
});

test('single-seat process audit failure blocks child startup with a typed error', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
    processAuditEnforcement: 'report-only',
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    processAuditor: async () => ({
      ok: false,
      findings: [{ severity: 'error', kind: 'process_audit_failed', message: 'ps unavailable' }],
      editors: [],
    }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'audit-unavailable-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const call = await client.request(2, 'tools/call', { name: 'editor_status', arguments: {} });
  assert.equal(call.result.structuredContent.code, 'EDITOR_PROCESS_AUDIT_UNAVAILABLE');
  assert.equal(core.children.size, 0);
});

test('manual same-target handoff proves an absent typed tool before dispatch and falls back cleanly', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const exactEditor = { pid: 780, projectPath: harness.config.projects[0].path };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: harness.stateFile,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_HANDOFF_STATUS_UNAVAILABLE: '1',
    },
    processAuditor: async () => ({ ok: true, findings: [], editors: [exactEditor] }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const admin = attach(core, 'A', { clientId: 'manual-status-fallback-admin', isAdmin: true });
  await admin.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const started = await admin.request(2, 'tools/call', {
    name: 'unity_router_editor_use', arguments: { project: 'A' },
  });
  const operationId = started.result.structuredContent.operationId;
  const completed = await waitUntil(() => {
    const snapshot = core.editorLifecycle.status(operationId);
    return snapshot?.state === 'COMPLETED' ? snapshot : null;
  });

  assert.equal(completed.target.project, 'A');
  assert.equal(journal.get(operationId).state, 'COMPLETED');
  const events = (await readFile(harness.stateFile, 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.kind === 'call-start' &&
    event.name === 'zamgune_handoff_status').length, 0);
  assert.equal(events.filter((event) => event.kind === 'call-start' &&
    event.name === 'editor_status').length, 1);
  assert.equal(events.filter((event) => event.kind === 'tools-list').length, 1);
  assert.equal(events.some((event) => event.kind === 'mutation'), false);
});

test('parser-shaped lifecycle errors stay fail-closed without stable catalog absence proof', async (t) => {
  for (const catalogMode of ['present', 'empty', 'malformed', 'error']) {
    await t.test(catalogMode, async (t) => {
      const harness = await fixture(t, {
        license: { mode: 'single-seat', maxConcurrentEditors: 1 },
      });
      const journal = await OperationJournal.open(harness.config.broker.journalFile);
      const exactEditor = { pid: 781, projectPath: harness.config.projects[0].path };
      const core = new BrokerCore({
        config: harness.config,
        journal,
        env: {
          ...process.env,
          FAKE_UNITY_STATE_FILE: harness.stateFile,
          FAKE_UNITY_VERSION: '1.0.0-beta.3',
          FAKE_UNITY_HANDOFF_STATUS_UNAVAILABLE: '1',
          FAKE_UNITY_HANDOFF_STATUS_ERROR_SHAPE: 'parser-match',
          FAKE_UNITY_HANDOFF_STATUS_CATALOG_MODE: catalogMode,
        },
        processAuditor: async () => ({ ok: true, findings: [], editors: [exactEditor] }),
        toolRefreshIntervalMs: 0,
      });
      t.after(() => core.close());
      const admin = attach(core, 'A', { clientId: `catalog-negative-${catalogMode}`, isAdmin: true });
      await admin.request(1, 'initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
      });

      const started = await admin.request(2, 'tools/call', {
        name: 'unity_router_editor_use', arguments: { project: 'A' },
      });
      const operationId = started.result.structuredContent.operationId;
      await waitUntil(async () => {
        const contents = await readFile(harness.stateFile, 'utf8').catch(() => '');
        return contents.includes('"kind":"tools-list"');
      });
      await waitUntil(() => core.editorLifecycle.status(operationId)?.state === 'WAITING_PIPELINE');

      const events = (await readFile(harness.stateFile, 'utf8'))
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(events.some((event) => event.kind === 'call-start' &&
        event.name === 'editor_status'), false);
      assert.deepEqual(core.editorLifecycle.status(operationId).blockers, ['EDITOR_LIFECYCLE_TOOL_ERROR']);
    });
  }
});

test('list_changed during lifecycle catalog proof prevents fallback', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const exactEditor = { pid: 782, projectPath: harness.config.projects[0].path };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: harness.stateFile,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_HANDOFF_STATUS_UNAVAILABLE: '1',
      FAKE_UNITY_HANDOFF_STATUS_ERROR_SHAPE: 'parser-match',
      FAKE_UNITY_NOTIFY_DURING_TOOLS_LIST_ONCE: '1',
      FAKE_UNITY_TOOLS_LIST_DELAY_MS: '90',
    },
    processAuditor: async () => ({ ok: true, findings: [], editors: [exactEditor] }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const admin = attach(core, 'A', { clientId: 'catalog-list-changed-negative', isAdmin: true });
  await admin.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const started = await admin.request(2, 'tools/call', {
    name: 'unity_router_editor_use', arguments: { project: 'A' },
  });
  const operationId = started.result.structuredContent.operationId;
  await waitUntil(() => core.editorLifecycle.status(operationId)?.state === 'WAITING_PIPELINE');
  const events = (await readFile(harness.stateFile, 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  assert(events.some((event) => event.kind === 'tools-list-notify-once'));
  assert.equal(events.some((event) => event.kind === 'call-start' && event.name === 'editor_status'), false);
  assert.deepEqual(core.editorLifecycle.status(operationId).blockers, ['EDITOR_LIFECYCLE_TOOL_ERROR']);
});

test('a wedged lifecycle catalog proof is bounded and never enables fallback', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const exactEditor = { pid: 783, projectPath: harness.config.projects[0].path };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: harness.stateFile,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_HANDOFF_STATUS_UNAVAILABLE: '1',
      FAKE_UNITY_HANDOFF_STATUS_ERROR_SHAPE: 'parser-match',
      FAKE_UNITY_TOOLS_LIST_DELAY_MS: '10000',
    },
    processAuditor: async () => ({ ok: true, findings: [], editors: [exactEditor] }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const admin = attach(core, 'A', { clientId: 'catalog-timeout-negative', isAdmin: true });
  await admin.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const before = Date.now();
  await admin.request(2, 'tools/call', {
    name: 'unity_router_editor_use', arguments: { project: 'A' },
  });
  await waitUntil(async () => {
    const contents = await readFile(harness.stateFile, 'utf8').catch(() => '');
    const observed = contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return observed.filter((event) => event.kind === 'call-start' &&
      event.name === 'zamgune_handoff_status').length >= 2;
  }, 6_500);
  const elapsedMs = Date.now() - before;
  const events = (await readFile(harness.stateFile, 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  assert(elapsedMs < 6_500, `catalog proof exceeded its bounded retry window: ${elapsedMs}ms`);
  assert.equal(events.some((event) => event.kind === 'call-start' && event.name === 'editor_status'), false);
});

test('floating validation turn preserves the legacy lease-only guard without Editor handoff', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const editorLifecycle = fakeEditorLifecycle(harness.config);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'floating-workspace-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const begun = await client.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  assert.equal(begun.result.isError, undefined);
  assert.equal(begun.result.structuredContent.editorUse, null);
  assert.equal(editorLifecycle.calls.length, 0);
  const ended = await client.request(3, 'tools/call', {
    name: 'unity_router_workspace_end',
    arguments: { leaseToken: begun.result.structuredContent.token },
  });
  assert.equal(ended.result.isError, undefined);
});

test('validation turn cannot end or resolve while manual Editor handoff is non-terminal', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let active = null;
  const editorLifecycle = {
    async ready() {},
    async ensureProject(project) {
      active = Object.freeze({
        operationId: '123e4567-e89b-42d3-a456-426614174001',
        target: Object.freeze({ project: project.name, projectKey: project.key, projectPath: project.path }),
        state: 'WAITING_MANUAL_CLOSE',
        blockers: Object.freeze([]),
        mode: 'manual-close',
      });
      return active;
    },
    status(operationId) { return active?.operationId === operationId ? active : null; },
    activeStatus() { return active; },
    async close() { active = null; },
  };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const owner = attach(core, 'A', { clientId: 'manual-handoff-owner' });
  const admin = attach(core, 'A', { clientId: 'manual-handoff-admin', isAdmin: true });
  for (const client of [owner, admin]) {
    await client.request(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
  }

  const begun = await owner.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  const token = begun.result.structuredContent.token;
  const ended = await owner.request(3, 'tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken: token },
  });
  assert.equal(ended.result.isError, true);
  assert.equal(ended.result.structuredContent.code, 'WORKSPACE_EDITOR_HANDOFF_ACTIVE');
  const resolved = await admin.request(2, 'tools/call', {
    name: 'unity_router_workspace_resolve', arguments: { leaseToken: token, confirm: true },
  });
  assert.equal(resolved.result.isError, true);
  assert.equal(resolved.result.structuredContent.code, 'WORKSPACE_EDITOR_HANDOFF_ACTIVE');
});

test('workspace begin keeps its lease when Editor handoff setup throws until the exact owner ends it', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let ensureCalls = 0;
  const editorLifecycle = {
    async ready() {},
    async ensureProject() {
      ensureCalls += 1;
      const error = new Error('deterministic Editor handoff setup failure');
      error.code = 'EDITOR_HANDOFF_SETUP_FAILED';
      throw error;
    },
    status() { return null; },
    activeStatus() { return null; },
    async close() {},
  };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const owner = attach(core, 'A', { clientId: 'handoff-throw-owner' });
  const contender = attach(core, 'A', { clientId: 'handoff-throw-contender' });
  for (const client of [owner, contender]) {
    await client.request(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
  }

  const begun = await owner.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  const token = begun.result.structuredContent.token;
  assert.equal(begun.result.isError, undefined);
  assert.equal(typeof token, 'string');
  assert.equal(begun.result.structuredContent.state, 'active');
  assert.equal(begun.result.structuredContent.editorUse.operationId, null);
  assert.equal(begun.result.structuredContent.editorUse.state, 'BLOCKED');
  assert.deepEqual(begun.result.structuredContent.editorUse.blockers, ['EDITOR_HANDOFF_SETUP_FAILED']);
  assert.equal(begun.result.structuredContent.editorUse.target.project, 'A');
  assert.equal(begun.result.structuredContent.editorUse.message, 'deterministic Editor handoff setup failure');
  assert.equal(core.workspaceRecords.get(token)?.editorUseOperationId, null);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 1);

  const contenderBegin = contender.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  await waitUntil(() => core.leases.listQueued({ key: 'source-refresh' }).length === 1);
  assert.equal(contender.messages.some((message) => message.id === 2), false);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 1);

  const ended = await owner.request(3, 'tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken: token },
  });
  assert.equal(ended.result.isError, undefined);
  assert.deepEqual(ended.result.structuredContent, { token, project: 'A', state: 'RELEASED' });
  assert.equal(core.workspaceRecords.has(token), false);

  const contenderBegun = await contenderBegin;
  const contenderToken = contenderBegun.result.structuredContent.token;
  assert.equal(contenderBegun.result.isError, undefined);
  assert.notEqual(contenderToken, token);
  assert.equal(contenderBegun.result.structuredContent.editorUse.operationId, null);
  assert.equal(contenderBegun.result.structuredContent.editorUse.state, 'BLOCKED');
  assert.equal(ensureCalls, 2);
  const contenderEnded = await contender.request(3, 'tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken: contenderToken },
  });
  assert.equal(contenderEnded.result.isError, undefined);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 0);
});

test('workspace end releases a lease after its tracked Editor handoff reaches a non-COMPLETED terminal state', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const operationId = '123e4567-e89b-42d3-a456-426614174002';
  let state = 'WAITING_MANUAL_CLOSE';
  let target = null;
  const snapshot = () => Object.freeze({
    operationId,
    target,
    state,
    blockers: Object.freeze([]),
    mode: 'manual-close',
  });
  const editorLifecycle = {
    async ready() {},
    async ensureProject(project) {
      target = Object.freeze({ project: project.name, projectKey: project.key, projectPath: project.path });
      return snapshot();
    },
    status(candidate) { return candidate === operationId ? snapshot() : null; },
    activeStatus() { return snapshot(); },
    async close() {},
  };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const owner = attach(core, 'A', { clientId: 'terminal-handoff-owner' });
  await owner.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const begun = await owner.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  const token = begun.result.structuredContent.token;
  assert.equal(begun.result.structuredContent.editorUse.operationId, operationId);
  assert.equal(core.workspaceRecords.get(token)?.editorUseOperationId, operationId);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 1);

  state = 'CANCELLED';
  const ended = await owner.request(3, 'tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken: token },
  });
  assert.equal(ended.result.isError, undefined);
  assert.deepEqual(ended.result.structuredContent, { token, project: 'A', state: 'RELEASED' });
  assert.equal(core.workspaceRecords.has(token), false);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 0);
});

test('workspace with no recorded handoff id waits for another active handoff to become terminal', async (t) => {
  const harness = await fixture(t, {
    projects: ['A', 'B'],
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const otherProject = harness.config.projects.find((project) => project.name === 'B');
  const operationId = '123e4567-e89b-42d3-a456-426614174003';
  let activeState = 'WAITING_TARGET_PROCESS';
  const activeSnapshot = () => Object.freeze({
    operationId,
    target: Object.freeze({
      project: otherProject.name,
      projectKey: otherProject.key,
      projectPath: otherProject.path,
    }),
    state: activeState,
    blockers: Object.freeze([]),
    mode: 'manual-close',
  });
  const editorLifecycle = {
    async ready() {},
    async ensureProject() {
      const error = new Error('target handoff cannot start while another handoff owns the lifecycle');
      error.code = 'EDITOR_HANDOFF_ALREADY_ACTIVE';
      throw error;
    },
    status() { return null; },
    activeStatus() { return activeSnapshot(); },
    async close() {},
  };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const owner = attach(core, 'A', { clientId: 'untracked-active-handoff-owner' });
  await owner.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const begun = await owner.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  const token = begun.result.structuredContent.token;
  assert.equal(begun.result.structuredContent.editorUse.operationId, null);
  assert.equal(core.workspaceRecords.get(token)?.editorUseOperationId, null);

  const blocked = await owner.request(3, 'tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken: token },
  });
  assert.equal(blocked.result.isError, true);
  assert.equal(blocked.result.structuredContent.code, 'WORKSPACE_EDITOR_HANDOFF_ACTIVE');
  assert.equal(blocked.result.structuredContent.editorUse.operationId, operationId);
  assert.equal(blocked.result.structuredContent.editorUse.state, 'WAITING_TARGET_PROCESS');
  assert.equal(blocked.result.structuredContent.editorUse.target.project, 'B');
  assert.equal(core.workspaceRecords.has(token), true);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 1);

  activeState = 'FAILED';
  const ended = await owner.request(4, 'tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken: token },
  });
  assert.equal(ended.result.isError, undefined);
  assert.deepEqual(ended.result.structuredContent, { token, project: 'A', state: 'RELEASED' });
  assert.equal(core.workspaceRecords.has(token), false);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 0);
});

test('single-seat mutation is cancelled before child startup if the Editor closes while queued', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let audits = 0;
  const exactEditor = { pid: 777, projectPath: harness.config.projects[0].path };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => ({
      ok: true,
      findings: [],
      editors: audits++ === 0 ? [exactEditor] : [],
    }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'editor-closes-before-child' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const result = await client.request(2, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'must-not-start-child' },
  });
  assert.equal(result.result.structuredContent.code, 'PROJECT_EDITOR_INACTIVE');
  assert.equal(result.result.structuredContent.routerOperationState, 'CANCELLED');
  assert.equal(core.children.size, 0);
  const events = await readFile(harness.stateFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert(!events.includes('must-not-start-child'));
  assert(!events.includes('"kind":"mutation"'));
});

test('single-seat mutation rechecks the exact Editor after child startup and before dispatch', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let audits = 0;
  const exactEditor = { pid: 778, projectPath: harness.config.projects[0].path };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => ({
      ok: true,
      findings: [],
      editors: audits++ < 3 ? [exactEditor] : [],
    }),
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'editor-closes-before-dispatch' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const result = await client.request(2, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'must-not-dispatch' },
  });
  assert.equal(result.result.structuredContent.code, 'PROJECT_EDITOR_INACTIVE');
  assert.equal(result.result.structuredContent.routerOperationState, 'CANCELLED');
  const events = await readFile(harness.stateFile, 'utf8');
  assert(events.includes('"kind":"spawn"'));
  assert(!events.includes('must-not-dispatch'));
});

test('single-seat retry cannot auto-restart a child after its audited dispatch window', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const exactEditor = { pid: 779, projectPath: harness.config.projects[0].path };
  let core;
  let auditsWithChild = 0;
  let childStoppedAfterAudit = false;
  const coreOptions = {
    config: harness.config,
    journal,
    editorLifecycle: fakeEditorLifecycle(harness.config),
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async ({ childPids }) => {
      if (childStoppedAfterAudit) {
        return { ok: true, findings: [], editors: [] };
      }
      if (childPids.length > 0) {
        auditsWithChild += 1;
        if (auditsWithChild === 2) {
          const child = [...core.children.values()][0];
          await child.stop('tool-retry');
          childStoppedAfterAudit = true;
        }
      }
      return { ok: true, findings: [], editors: [exactEditor] };
    },
    toolRefreshIntervalMs: 0,
  };
  core = new BrokerCore(coreOptions);
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'audited-retry-gap' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const result = await client.request(2, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'must-not-auto-restart-after-audit' },
  });
  assert.equal(childStoppedAfterAudit, true);
  assert.equal(result.result.structuredContent.code, 'PROJECT_EDITOR_INACTIVE');
  assert.equal(result.result.structuredContent.routerOperationState, 'CANCELLED');
  const events = await readFile(harness.stateFile, 'utf8');
  assert(!events.includes('must-not-auto-restart-after-audit'));
});

test('an attached client cannot trigger requests or background discovery before initialized notification', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const messages = [];
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 50,
  });
  t.after(() => core.close());
  core.attach({
    clientId: 'phase-client',
    sessionNonce: 'phase-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    send: (message) => messages.push(message),
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(() => readFile(harness.stateFile, 'utf8'), { code: 'ENOENT' });
  await core.handle('phase-client', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase', version: '1' } },
  });
  await core.handle('phase-client', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(messages.find((message) => message.id === 2)?.error?.code, -32002);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(() => readFile(harness.stateFile, 'utf8'), { code: 'ENOENT' });

  await core.handle('phase-client', {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });
  await core.handle('phase-client', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert(messages.find((message) => message.id === 3)?.result?.tools?.some((tool) => tool.name === 'editor_status'));
});

test('cancellation received while lifecycle recovery is pending cannot overtake request registration', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const recoveryGate = deferred();
  const editorLifecycle = {
    ...fakeEditorLifecycle(harness.config),
    ready: () => recoveryGate.promise,
  };
  const messages = [];
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const connection = core.attach({
    clientId: 'early-cancel-client',
    sessionNonce: 'early-cancel-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    send: (message) => messages.push(message),
  });
  await core.handle(connection.id, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  await core.handle(connection.id, {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });

  const pending = core.handle(connection.id, {
    jsonrpc: '2.0', id: 7002, method: 'resources/list', params: {},
  });
  await waitUntil(() => connection.incomingRequests.size === 1);
  await core.handle(connection.id, {
    jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: 7002, reason: 'cancel during recovery' },
  });
  recoveryGate.resolve();
  await pending;

  assert.equal(messages.find((message) => message.id === 7002)?.error?.code, -32800);
  assert.equal(connection.incomingRequests.size, 0);
  assert.equal(connection.earlyCancellations.size, 0);
  assert.equal(core.children.size, 0);
});

test('early tools/call cancellation returns a non-dispatched tool result after lifecycle recovery', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const recoveryGate = deferred();
  const editorLifecycle = {
    ...fakeEditorLifecycle(harness.config),
    ready: () => recoveryGate.promise,
  };
  const messages = [];
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const connection = core.attach({
    clientId: 'early-tool-cancel-client',
    sessionNonce: 'early-tool-cancel-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    send: (message) => messages.push(message),
  });
  await core.handle(connection.id, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  await core.handle(connection.id, {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });

  const pending = core.handle(connection.id, {
    jsonrpc: '2.0', id: 7004, method: 'tools/call',
    params: { name: 'mutate_once', arguments: { marker: 'must-not-dispatch' } },
  });
  await waitUntil(() => connection.incomingRequests.size === 1);
  await core.handle(connection.id, {
    jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: 7004, reason: 'cancel during recovery' },
  });
  recoveryGate.resolve();
  await pending;

  const cancelled = messages.find((message) => message.id === 7004);
  assert.equal(cancelled?.result?.structuredContent?.state, 'CANCELLED');
  assert.equal(cancelled?.result?.structuredContent?.code, 'NOT_DISPATCHED');
  assert.equal(cancelled?.result?.isError, true);
  assert.equal(connection.incomingRequests.size, 0);
  assert.equal(connection.earlyCancellations.size, 0);
  assert.equal(core.children.size, 0);
});

test('disconnect during lifecycle recovery cannot execute a stale admin request', async (t) => {
  const harness = await fixture(t, {
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
  });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const recoveryGate = deferred();
  const editorLifecycle = {
    ...fakeEditorLifecycle(harness.config),
    ready: () => recoveryGate.promise,
  };
  const messages = [];
  const core = new BrokerCore({
    config: harness.config,
    journal,
    editorLifecycle,
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const connection = core.attach({
    clientId: 'recovery-disconnect-admin',
    sessionNonce: 'recovery-disconnect-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    isAdmin: true,
    send: (message) => messages.push(message),
  });
  await core.handle(connection.id, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  await core.handle(connection.id, {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });

  const pending = core.handle(connection.id, {
    jsonrpc: '2.0', id: 7003, method: 'tools/call',
    params: { name: 'unity_router_editor_use', arguments: { project: 'A' } },
  });
  await waitUntil(() => connection.incomingRequests.size === 1);
  core.detach(connection.id);
  recoveryGate.resolve();
  await pending;

  assert.equal(editorLifecycle.calls.length, 0);
  assert.equal(messages.some((message) => message.id === 7003), false);
  assert.equal(core.connections.has(connection.id), false);
  assert.equal(connection.incomingRequests.size, 0);
});

test('project access denial keeps native diagnostics alive and never spawns or dispatches Unity', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const projectAccessAuditor = controllableProjectAccessAuditor(harness.config);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
    projectAccessAuditor,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const listed = await client.request(2, 'tools/list');
  assert(listed.result.tools.some((tool) => tool.name === 'unity_router_status'));
  assert(!listed.result.tools.some((tool) => tool.name === 'editor_status'));
  const status = await client.request(3, 'tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(status.result.structuredContent.broker.executable, process.execPath);
  assert.equal(status.result.structuredContent.projectAccess.ok, false);
  const doctor = await client.request(4, 'tools/call', { name: 'unity_router_doctor', arguments: {} });
  assert.equal(doctor.result.isError, true);
  assert.equal(doctor.result.structuredContent.processAudit.ok, true);
  assert.equal(doctor.result.structuredContent.projectAccess.ok, false);
  assert.equal(doctor.result.structuredContent.findings[0].kind, 'project_access_failed');

  const mutation = await client.request(5, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'must-not-dispatch' },
  });
  assert.equal(mutation.error?.data?.brokerCode, 'PROJECT_ACCESS_DENIED');
  assert.equal(journal.list({ state: 'UNKNOWN_OUTCOME' }).length, 0);
  assert.equal(core.children.get(harness.config.projects[0].key)?.snapshot().pid, null);
  const events = await readFile(harness.stateFile, 'utf8');
  assert(!events.includes('"kind":"spawn"'));
  assert(!events.includes('must-not-dispatch'));
});

test('tool discovery recovers after the project access grant changes', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const projectAccessAuditor = controllableProjectAccessAuditor(harness.config);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
    projectAccessAuditor,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  const blocked = await client.request(2, 'tools/list');
  assert(!blocked.result.tools.some((tool) => tool.name === 'editor_status'));

  projectAccessAuditor.state.allowed = true;
  const recovered = await client.request(3, 'tools/list');
  assert(recovered.result.tools.some((tool) => tool.name === 'editor_status'));
  assert.equal(core.children.get(harness.config.projects[0].key)?.snapshot().ready, true);
  assert(projectAccessAuditor.state.assertOptions.every((options) => options.force === true));
});

test('a process-audit block is an explicit tools/list error instead of an empty catalog', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let auditResult = {
    ok: false,
    editors: [],
    findings: [{
      severity: 'error',
      kind: 'editor_seat_limit_exceeded',
      editorCount: 2,
      maxConcurrentEditors: 1,
      pids: [25784, 30973],
    }],
  };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => auditResult,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const blocked = await client.request(2, 'tools/list');
  assert.equal(blocked.result, undefined);
  assert.equal(blocked.error.data.brokerCode, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(blocked.error.data.details.findings[0].kind, 'editor_seat_limit_exceeded');
  assert.match(blocked.error.message, /editor_seat_limit_exceeded pid 25784, 30973/);

  auditResult = CLEAN_AUDIT;
  core.auditCache = null;
  const recovered = await client.request(3, 'tools/list');
  assert(recovered.result.tools.some((tool) => tool.name === 'editor_status'));
});

test('a known catalog stays invalidated when reload recovery exceeds its empty grace', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const toolsGateFile = path.join(harness.root, 'tools-ready');
  await writeFile(toolsGateFile, 'ready');
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: harness.stateFile,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_TOOLS_GATE_FILE: toolsGateFile,
      FAKE_UNITY_TOOLS_LIST_DELAY_MS: '100',
    },
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
    toolCatalogRecoveryGraceMs: 500,
    toolCatalogRecoveryPollMs: 5,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'catalog-recovery-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  const initial = await client.request(2, 'tools/list');
  assert(initial.result.tools.some((tool) => tool.name === 'editor_status'));

  await rm(toolsGateFile);
  const recompile = await client.request(3, 'tools/call', {
    name: 'recompile',
    arguments: { mode: 'sync_success', notifyToolsChanged: true, marker: 'catalog-recovery-timeout' },
  });
  const operationId = readRouterOperationMeta(recompile.result)?.routerOperationId;
  assert.equal(typeof operationId, 'string');
  await core.acknowledgeResponse(client.clientId, { operationId, requestId: 3 });

  const recoveryStartedAt = Date.now();
  const recovering = await client.request(4, 'tools/list');
  assert.equal(recovering.error?.data?.brokerCode, 'TOOL_CATALOG_RECOVERING');
  assert(Date.now() - recoveryStartedAt < 750, 'catalog recovery must honor its hard grace deadline');
  const projectKey = harness.config.projects[0].key;
  assert.equal(core.toolRegistry.get(projectKey), null);
  assert.equal(core.toolRegistry.hasKnownNonEmptyCatalog(projectKey), true);

  await writeFile(toolsGateFile, 'ready');
  await waitUntil(() => !core.toolDiscoveryInFlight.has(projectKey));
  const recovered = await client.request(5, 'tools/list');
  assert(recovered.result, JSON.stringify(recovered));
  assert(recovered.result.tools.some((tool) => tool.name === 'editor_status'));
});

test('a first post-invalidation discovery error is fail-closed as catalog recovery', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const toolsErrorGateFile = path.join(harness.root, 'tools-error');
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: harness.stateFile,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_TOOLS_ERROR_GATE_FILE: toolsErrorGateFile,
    },
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
    toolCatalogRecoveryGraceMs: 40,
    toolCatalogRecoveryPollMs: 5,
  });
  t.after(() => core.close());
  const clients = [
    attach(core, 'A', { clientId: 'catalog-error-client-a' }),
    attach(core, 'A', { clientId: 'catalog-error-client-b' }),
  ];
  for (let index = 0; index < clients.length; index += 1) {
    await clients[index].request(index + 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: `test-${index}`, version: '1' },
    });
  }
  const initial = await clients[0].request(10, 'tools/list');
  assert(initial.result.tools.some((tool) => tool.name === 'editor_status'));
  await clients[1].request(11, 'tools/list');
  for (const client of clients) client.messages.length = 0;

  const recompile = await clients[0].request(12, 'tools/call', {
    name: 'recompile',
    arguments: { mode: 'sync_success', notifyToolsChanged: true, marker: 'catalog-error-recovery' },
  });
  const operationId = readRouterOperationMeta(recompile.result)?.routerOperationId;
  assert.equal(typeof operationId, 'string');
  await core.acknowledgeResponse(clients[0].clientId, { operationId, requestId: 12 });
  assert.deepEqual(clients.map((client) => client.messages.filter((message) =>
    message.method === 'notifications/tools/list_changed').length), [1, 1]);

  await writeFile(toolsErrorGateFile, 'error');
  const recoveryStartedAt = Date.now();
  const recovering = await clients[0].request(13, 'tools/list');
  assert.equal(recovering.error?.data?.brokerCode, 'TOOL_CATALOG_RECOVERING');
  assert(Date.now() - recoveryStartedAt < 250, 'catalog recovery must honor its hard grace deadline');
  const projectKey = harness.config.projects[0].key;
  assert.equal(core.toolRegistry.get(projectKey), null);
  assert.equal(core.toolRegistry.hasKnownNonEmptyCatalog(projectKey), true);

  await rm(toolsErrorGateFile);
  const recovered = await clients[1].request(14, 'tools/list');
  assert(recovered.result.tools.some((tool) => tool.name === 'editor_status'));
  assert.deepEqual(clients.map((client) => client.messages.filter((message) =>
    message.method === 'notifications/tools/list_changed').length), [1, 1]);
});

test('a malformed downstream tools/list is an explicit error instead of an empty catalog', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: harness.stateFile,
      FAKE_UNITY_VERSION: '1.0.0-beta.3',
      FAKE_UNITY_MALFORMED_TOOLS_ONCE: 'entry',
    },
    processAuditor: async () => CLEAN_AUDIT,
    toolRefreshIntervalMs: 0,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'malformed-catalog-client' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const malformed = await client.request(2, 'tools/list');
  assert.equal(malformed.error?.data?.brokerCode, 'INVALID_TOOL_CATALOG');
  assert.equal(core.toolRegistry.get(harness.config.projects[0].key), null);

  const recovered = await client.request(3, 'tools/list');
  assert(recovered.result.tools.some((tool) => tool.name === 'editor_status'));
});

test('enforced process audit blocks a bypass before dispatch and recovers after it clears', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let unsafe = true;
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => unsafe
      ? {
          ok: false,
          findings: [{ severity: 'error', kind: 'direct_unmanaged_unity_mcp', pid: 991, projectPath: harness.config.projects[0].path }],
          editors: [],
        }
      : CLEAN_AUDIT,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const blocked = await client.request(2, 'tools/call', { name: 'mutate_once', arguments: { marker: 'blocked' } });
  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');

  unsafe = false;
  core.auditCache = null;
  const allowed = await client.request(3, 'tools/call', { name: 'mutate_once', arguments: { marker: 'allowed' } });
  assert.equal(allowed.result?.isError, false);
});

test('enforced process audit blocks mutation while an orphaned Unity 6.5 bee backend exists', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => ({
      ok: false,
      findings: [{ severity: 'error', kind: 'orphaned_bee_backend', pids: [992] }],
      editors: [],
      beeBackends: [{ pid: 992, ppid: 1, editorPid: null }],
    }),
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const blocked = await client.request(2, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'blocked-by-bee-audit' },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(blocked.result?.structuredContent?.findings?.[0]?.kind, 'orphaned_bee_backend');
});

test('concurrent forced process audits coalesce one fresh follow-up without overlap', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const gate = deferred();
  let auditCalls = 0;
  let activeAudits = 0;
  let maxActiveAudits = 0;
  const projectAccessAuditor = controllableProjectAccessAuditor(harness.config, { allowed: true });
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => {
      auditCalls += 1;
      activeAudits += 1;
      maxActiveAudits = Math.max(maxActiveAudits, activeAudits);
      try {
        if (auditCalls === 1) return await gate.promise;
        return CLEAN_AUDIT;
      } finally {
        activeAudits -= 1;
      }
    },
    projectAccessAuditor,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const first = client.request(2, 'tools/call', { name: 'unity_router_doctor', arguments: {} });
  await waitUntil(() => auditCalls === 1);
  const second = client.request(3, 'tools/call', { name: 'unity_router_doctor', arguments: {} });
  const third = client.request(4, 'tools/call', { name: 'unity_router_doctor', arguments: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auditCalls, 1);

  gate.resolve(CLEAN_AUDIT);
  const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
  assert.notEqual(firstResult.result?.isError, true);
  assert.notEqual(secondResult.result?.isError, true);
  assert.notEqual(thirdResult.result?.isError, true);
  assert.equal(auditCalls, 2, 'forced callers during one generation must share one follow-up');
  assert.equal(maxActiveAudits, 1, 'process-table audits must remain single-flight');

  const next = await client.request(5, 'tools/call', { name: 'unity_router_doctor', arguments: {} });
  assert.notEqual(next.result?.isError, true);
  assert.equal(auditCalls, 3, 'a later forced doctor must run a fresh audit');
});

test('queued mutation gets a fresh forced audit after an older status snapshot', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const gate = deferred();
  let auditCalls = 0;
  let blockNextAudit = false;
  let unsafe = false;
  const unsafeAudit = {
    ok: false,
    findings: [{
      severity: 'error',
      kind: 'direct_unmanaged_unity_mcp',
      pid: 99_998,
      projectPath: harness.config.projects[0].path,
    }],
    editors: [],
  };
  const projectAccessAuditor = controllableProjectAccessAuditor(harness.config, { allowed: true });
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => {
      auditCalls += 1;
      const captured = unsafe ? unsafeAudit : CLEAN_AUDIT;
      if (blockNextAudit) {
        blockNextAudit = false;
        await gate.promise;
      }
      return captured;
    },
    projectAccessAuditor,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  await client.request(2, 'tools/list');

  core.auditCache = null;
  auditCalls = 0;
  const blocker = client.request(3, 'tools/call', {
    name: 'editor_status', arguments: { delayMs: 300, marker: 'freshness-blocker' },
  });
  await waitUntil(() => core.schedulers.get(harness.config.projects[0].key)?.snapshot().activeOperationId);
  const mutation = client.request(4, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'must-not-run-on-stale-audit' },
  });
  await waitUntil(() => core.schedulers.get(harness.config.projects[0].key)?.snapshot().queued === 1);

  blockNextAudit = true;
  core.auditCache = null;
  const status = client.request(5, 'tools/call', { name: 'unity_router_status', arguments: {} });
  await waitUntil(() => auditCalls === 2);
  unsafe = true;
  await blocker;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auditCalls, 2, 'dispatch must wait instead of reusing the older status snapshot');

  gate.resolve();
  const [blocked, statusResult] = await Promise.all([mutation, status]);
  assert.notEqual(statusResult.result?.isError, true);
  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(blocked.result?.structuredContent?.routerOperationState, 'CANCELLED');
  assert.equal(auditCalls, 3, 'one fresh follow-up audit must observe the new conflict');
  const events = await readFile(harness.stateFile, 'utf8');
  assert(!events.includes('must-not-run-on-stale-audit'));
});

test('an unconfigured or path-unknown Editor blocks dispatch globally', async (t) => {
  for (const kind of ['unconfigured_editor', 'editor_project_unknown']) {
    const harness = await fixture(t);
    const journal = await OperationJournal.open(harness.config.broker.journalFile);
    const core = new BrokerCore({
      config: harness.config,
      journal,
      env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
      processAuditor: async () => ({
        ok: false,
        findings: [{ severity: 'error', kind, pid: 993, projectPath: '/SymlinkOrUnknown' }],
        editors: [],
      }),
    });
    const client = attach(core, 'A', { clientId: `client-${kind}` });
    await client.request(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    const blocked = await client.request(2, 'tools/call', {
      name: 'mutate_once', arguments: { marker: `blocked-${kind}` },
    });
    assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
    await core.close();
  }
});

test('a process conflict appearing while queued is re-audited and blocked before Unity dispatch', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let auditCalls = 0;
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => {
      auditCalls += 1;
      if (auditCalls === 1) return CLEAN_AUDIT;
      return {
        ok: false,
        findings: [{
          severity: 'error',
          kind: 'direct_unmanaged_unity_mcp',
          pid: 992,
          projectPath: harness.config.projects[0].path,
        }],
        editors: [],
      };
    },
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  const blocked = await client.request(2, 'tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'dispatch-race-must-not-run' },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(blocked.result?.structuredContent?.routerOperationState, 'CANCELLED');
  const operationId = blocked.result?.structuredContent?.routerOperationId;
  assert.equal(journal.get(operationId)?.state, 'CANCELLED');
  const events = await readFile(harness.stateFile, 'utf8');
  assert(!events.includes('dispatch-race-must-not-run'));
});

test('a completed mutation whose response is dropped before adapter ACK becomes fenced and is not replayed', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
  });
  t.after(() => core.close());

  let droppedOperationId = null;
  core.attach({
    clientId: 'delivery-victim',
    sessionNonce: 'delivery-victim-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    send: (message) => {
      const metadata = readRouterOperationMeta(message?.result);
      if (message.id === 2 && metadata?.routerDeliveryAckRequired === true) {
        droppedOperationId = metadata.routerOperationId;
        core.detach('delivery-victim');
      }
    },
  });
  await core.handle('delivery-victim', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  await core.handle('delivery-victim', {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });
  await core.handle('delivery-victim', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'mutate_once', arguments: { marker: 'delivery-gap-once' } },
  });
  assert.equal(typeof droppedOperationId, 'string');
  await waitUntil(() => journal.get(droppedOperationId)?.state === 'UNKNOWN_OUTCOME');

  const observer = attach(core, 'A', { clientId: 'delivery-observer' });
  await observer.request(10, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  const blocked = await observer.request(11, 'tools/call', {
    name: 'mutate_once', arguments: { marker: 'delivery-gap-retry' },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'PROJECT_UNKNOWN_OUTCOME_FENCE');
  const events = await readFile(harness.stateFile, 'utf8');
  assert.equal(events.split('\n').filter((line) => line.includes('"kind":"mutation"')).length, 1);
  assert(!events.includes('delivery-gap-retry'));
});

test('terminal async status waits for the trigger adapter ACK before finalizing', async (t) => {
  const harness = await fixture(t, { processAuditEnforcement: 'report-only' });
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
  });
  t.after(() => core.close());

  const trigger = attach(core, 'A', { clientId: 'async-trigger' });
  const observer = attach(core, 'A', { clientId: 'async-observer' });
  await Promise.all([
    trigger.request(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trigger', version: '1' },
    }),
    observer.request(10, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'observer', version: '1' },
    }),
  ]);

  const started = await trigger.request(2, 'tools/call', {
    name: 'build', arguments: { confirm: true, delayMs: 40, marker: 'terminal-before-ack' },
  });
  const operationId = started.result?.structuredContent?.routerOperationId;
  assert.equal(started.result?.structuredContent?.routerOperationState, 'RUNNING');
  assert.equal(typeof operationId, 'string');
  await waitUntil(async () => {
    try { return (await readFile(harness.stateFile, 'utf8')).includes('"kind":"async-complete"'); }
    catch { return false; }
  });

  const terminal = await observer.request(11, 'tools/call', {
    name: 'build_status', arguments: {},
  });
  assert.equal(terminal.result?.structuredContent?.status, 'completed');
  assert.equal(journal.get(operationId)?.state, 'RUNNING');
  const tracker = core.asyncByProject.get(harness.config.projects[0].key);
  assert.equal(tracker?.terminalObserved, true);
  assert.equal(tracker?.deliveryUncertain, true);
  assert(core.leases.list().length > 0);

  const acknowledged = await core.acknowledgeResponse(trigger.clientId, {
    operationId,
    requestId: 2,
  });
  assert.equal(acknowledged, true);
  await waitUntil(() => journal.get(operationId)?.state === 'COMPLETED');
  assert.equal(core.asyncByProject.size, 0);
  assert.equal(core.leases.list().length, 0);
  assert.equal(core.unknownByProject.size, 0);
});

test('workspace begin is fail-closed when a duplicate broker is detected', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let auditCalls = 0;
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => {
      auditCalls += 1;
      return {
        ok: false,
        findings: [{ severity: 'error', kind: 'duplicate_broker', pid: 99_991 }],
        editors: [],
      };
    },
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  const blocked = await client.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(core.workspaceRecords.size, 0);
  assert(auditCalls >= 1);
});

test('workspace begin re-audits after waiting for the source-refresh lease', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let unsafe = false;
  let auditCalls = 0;
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => {
      auditCalls += 1;
      return unsafe
        ? {
            ok: false,
            findings: [{ severity: 'error', kind: 'duplicate_broker', pid: 99_992 }],
            editors: [],
          }
        : CLEAN_AUDIT;
    },
  });
  t.after(() => core.close());
  const blockerIdentity = { ownerId: 'existing-writer', sessionNonce: 'existing-writer-session' };
  const blocker = await core.leases.acquire('source-refresh', { ...blockerIdentity, ttlMs: 60_000 });
  const client = attach(core, 'A', { clientId: 'waiting-writer' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });

  const begin = client.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  await waitUntil(() => core.leases.listQueued({ key: 'source-refresh' }).length === 1);
  assert.equal(auditCalls, 1);
  unsafe = true;
  core.leases.release(blocker, blockerIdentity);
  const blocked = await begin;

  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(auditCalls, 2);
  assert.equal(core.workspaceRecords.size, 0);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 0);
});

test('workspace heartbeat re-audits and refuses to extend a lease after a bypass appears', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let unsafe = false;
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => unsafe
      ? {
          ok: false,
          findings: [{ severity: 'error', kind: 'direct_unmanaged_unity_mcp', pid: 99_993 }],
          editors: [],
        }
      : CLEAN_AUDIT,
  });
  t.after(() => core.close());
  const client = attach(core, 'A', { clientId: 'heartbeat-writer' });
  await client.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  const begun = await client.request(2, 'tools/call', {
    name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 },
  });
  const token = begun.result?.structuredContent?.token;
  assert.equal(typeof token, 'string');
  const expiresAt = begun.result.structuredContent.expiresAt;

  unsafe = true;
  const blocked = await client.request(3, 'tools/call', {
    name: 'unity_router_workspace_heartbeat', arguments: { leaseToken: token, ttlSec: 600 },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'SYSTEM_CONCURRENCY_UNSAFE');
  assert.equal(core.workspaceRecords.get(token)?.expiresAt, expiresAt);
  assert.equal(core.leases.list({ key: 'source-refresh' }).length, 1);
});

test('workspace persistence attaches an in-flight lease to the reconnected owner session', async (t) => {
  const harness = await fixture(t);
  const journal = await OperationJournal.open(harness.config.broker.journalFile);
  let releaseUpsert;
  let enteredUpsert;
  const upsertEntered = new Promise((resolve) => { enteredUpsert = resolve; });
  const upsertGate = new Promise((resolve) => { releaseUpsert = resolve; });
  const durableRecords = new Map();
  const workspaceStore = {
    create: (input) => ({ ...input, token: 'reconnected-workspace-token' }),
    list: () => [],
    get: (token) => durableRecords.get(token) ?? null,
    health: () => ({ ok: true }),
    async upsert(record) {
      enteredUpsert();
      await upsertGate;
      durableRecords.set(record.token, structuredClone(record));
      return record;
    },
    async remove(token) { durableRecords.delete(token); },
    async close() {},
  };
  const core = new BrokerCore({
    config: harness.config,
    journal,
    workspaceStore,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
  });
  t.after(() => core.close());

  const oldMessages = [];
  core.attach({
    clientId: 'reconnecting-writer',
    sessionNonce: 'stable-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    send: (message) => oldMessages.push(message),
  });
  await core.handle('reconnecting-writer', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
  });
  await core.handle('reconnecting-writer', {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });
  const begin = core.handle('reconnecting-writer', {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 } },
  });
  await upsertEntered;

  core.detach('reconnecting-writer');
  const newMessages = [];
  const reconnected = core.attach({
    clientId: 'reconnecting-writer',
    sessionNonce: 'stable-session',
    defaultProject: 'A',
    clientKind: 'unit-test',
    send: (message) => newMessages.push(message),
  });
  await core.handle('reconnecting-writer', {
    jsonrpc: '2.0', id: 10, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'new', version: '1' } },
  });
  await core.handle('reconnecting-writer', {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  });
  releaseUpsert();
  await begin;

  assert.equal(durableRecords.size, 1);
  assert.equal(reconnected.workspaceLeases.size, 1);
  await core.handle('reconnecting-writer', {
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'unity_router_workspace_begin', arguments: { project: 'A', ttlSec: 60 } },
  });
  const recovered = newMessages.find((message) => message.id === 11);
  assert.equal(recovered?.result?.structuredContent?.token, 'reconnected-workspace-token');
});

test('a RUNNING operation whose global leases cannot be restored creates a project recovery fence', async (t) => {
  const harness = await fixture(t, { projects: ['A', 'B'], processAuditEnforcement: 'report-only' });
  let journal = await OperationJournal.open(harness.config.broker.journalFile);
  for (const project of harness.config.projects) {
    const id = `build-${project.name}`;
    await journal.recordReceived({
      operationId: id,
      project: project.name,
      projectKey: project.key,
      method: 'build',
      payload: {},
    });
    await journal.markQueued(id);
    await journal.markDispatching(id);
    await journal.markRunning(id, 'build_status', { buildId: `fake-${project.name}` });
  }
  await journal.close();
  journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
  });
  t.after(() => core.close());
  const client = attach(core, 'B');
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const blocked = await client.request(2, 'tools/call', { name: 'mutate_once', arguments: {} });
  assert.equal(blocked.result?.structuredContent?.code, 'PROJECT_RECOVERY_FENCE');
  assert.equal(blocked.result?.structuredContent?.faults?.[0]?.code, 'ASYNC_LEASE_RESTORE_FAILED');
});

test('a v2 stable project identity mismatch never falls back to a recycled alias', async (t) => {
  const harness = await fixture(t, { projects: ['A'], processAuditEnforcement: 'report-only' });
  let journal = await OperationJournal.open(harness.config.broker.journalFile);
  await journal.recordReceived({
    operationId: 'old-checkout-operation',
    project: 'A',
    projectKey: 'dev:old:ino:checkout',
    method: 'mutate_once',
    payload: {},
  });
  await journal.markQueued('old-checkout-operation');
  await journal.markDispatching('old-checkout-operation');
  await journal.close();
  journal = await OperationJournal.open(harness.config.broker.journalFile);
  const core = new BrokerCore({
    config: harness.config,
    journal,
    env: { ...process.env, FAKE_UNITY_STATE_FILE: harness.stateFile, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    processAuditor: async () => CLEAN_AUDIT,
  });
  t.after(() => core.close());
  const client = attach(core, 'A');
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const blocked = await client.request(2, 'tools/call', { name: 'mutate_once', arguments: {} });
  assert.equal(blocked.result?.structuredContent?.code, 'PROJECT_RECOVERY_FENCE');
  assert.equal(blocked.result?.structuredContent?.faults?.[0]?.code, 'UNKNOWN_PROJECT_NOT_CONFIGURED');
});
