import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { JsonRpcLineDecoder, encodeJsonRpcLine } from '../../lib/mcp-framing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROUTER = path.join(ROOT, 'unity-mcp-router.mjs');
const BROKER = path.join(ROOT, 'broker-daemon.mjs');
const FAKE_UNITY = path.join(ROOT, 'test/fixtures/fake-unity.mjs');

function waitUntil(predicate, { timeoutMs = 5_000, intervalMs = 20, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const value = await predicate();
        if (value) { resolve(value); return; }
        if (Date.now() >= deadline) { reject(new Error(`Timed out waiting for ${message}`)); return; }
        setTimeout(check, intervalMs);
      } catch (error) { reject(error); }
    };
    void check();
  });
}

async function readEvents(file) {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

class StdioMcpClient {
  constructor({ configPath, defaultProject, env, admin = false }) {
    this.proc = spawn(process.execPath, [
      ROUTER,
      '--config', configPath,
      '--default', defaultProject,
      ...(admin ? ['--admin'] : []),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.decoder = new JsonRpcLineDecoder();
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.nextId = 1;
    this.proc.stdout.on('data', (chunk) => {
      for (const message of this.decoder.push(chunk)) {
        if (message.id != null && this.pending.has(String(message.id))) {
          const entry = this.pending.get(String(message.id));
          this.pending.delete(String(message.id));
          clearTimeout(entry.timer);
          entry.resolve(message);
        } else {
          this.notifications.push(message);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.proc.on('exit', (code, signal) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`adapter exited code=${code} signal=${signal}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  async initialize(protocolVersion = '2025-06-18', clientName = 'integration-test') {
    const response = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: clientName, version: '1' },
    }, { timeoutMs: 15_000 });
    assert.equal(response.result?.capabilities?.tools?.listChanged, true);
    assert.deepEqual(response.result?.capabilities?.completions, {});
    assert.deepEqual(response.result?.capabilities?.prompts, { listChanged: false });
    assert.deepEqual(response.result?.capabilities?.resources, {
      subscribe: false,
      listChanged: false,
    });
    this.notify('notifications/initialized', {});
    return response;
  }

  request(method, params = {}, { id = this.nextId++, timeoutMs = 10_000 } = {}) {
    const key = String(id);
    assert(!this.pending.has(key), `duplicate client request id ${key}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`request timed out: ${method}; stderr=${this.stderr}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this.proc.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', method, params }));
  }

  async waitForNotification(method, timeoutMs = 5_000) {
    return waitUntil(() => this.notifications.find((message) => message.method === method), {
      timeoutMs,
      message: `notification ${method}`,
    });
  }

  async close() {
    if (this.proc.exitCode != null) return;
    this.proc.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.proc.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (this.proc.exitCode == null) this.proc.kill('SIGTERM');
  }
}

async function createHarness({
  toolTimeoutSec = 5,
  deadlineSec = 5,
  cliVersion = '1.0.0-beta.3',
  processAuditEnforcement = 'report-only',
  toolsInitiallyUnavailable = false,
  toolsListDelayMs = 0,
  notifyDuringToolsList = false,
  notifyAfterTerminalStatusMs = 0,
  childIdleMin = 1,
  initializeDelayOnceMs = 0,
  toolCatalogFileEnabled = false,
  cliVersionDelayMs = 0,
} = {}) {
  // AF_UNIX paths are limited to 104 bytes on macOS, so keep this deliberately
  // short. The production config validator enforces the same constraint.
  const root = await mkdtemp('/tmp/umcp-');
  let projectA = path.join(root, 'ProjectA');
  let projectB = path.join(root, 'ProjectB');
  const runtime = path.join(root, 'runtime');
  const stateFile = path.join(root, 'fake-events.jsonl');
  const toolsGateFile = path.join(root, 'tools-ready');
  const toolCatalogFile = path.join(root, 'tool-catalog-version');
  const configPath = path.join(root, 'config.json');
  await Promise.all([
    mkdir(path.join(projectA, 'Assets'), { recursive: true }),
    mkdir(path.join(projectA, 'ProjectSettings'), { recursive: true }),
    mkdir(path.join(projectB, 'Assets'), { recursive: true }),
    mkdir(path.join(projectB, 'ProjectSettings'), { recursive: true }),
    mkdir(runtime),
  ]);
  [projectA, projectB] = await Promise.all([realpath(projectA), realpath(projectB)]);
  await chmod(FAKE_UNITY, 0o755);
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 2,
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    defaultProject: 'a',
    projects: [
      { name: 'a', path: projectA },
      { name: 'b', path: projectB },
    ],
    startupTimeoutSec: 3,
    toolTimeoutSec,
    reauthIntervalMin: 0,
    queue: {
      maxPendingPerClient: 32,
      maxPendingPerProject: 128,
      maxPendingTotal: 512,
      maxHeavyInFlight: 1,
      deadlineSec,
    },
    recovery: { safeReadRetries: 1 },
    license: { mode: 'floating', maxConcurrentEditors: 2 },
    broker: {
      socketPath: path.join(runtime, 'broker-v2.sock'),
      journalFile: path.join(root, 'operations.jsonl'),
      workspaceLeaseFile: path.join(root, 'workspace-leases.json'),
      adminTokenFile: path.join(root, 'admin-token'),
      processAuditEnforcement,
      childIdleMin,
    },
    logFile: path.join(root, 'broker.log'),
  }, null, 2));
  return {
    root,
    projectA,
    projectB,
    stateFile,
    configPath,
    pidPath: path.join(runtime, 'broker-v2.pid'),
    toolsGateFile,
    toolCatalogFile,
    env: {
      ...process.env,
      FAKE_UNITY_STATE_FILE: stateFile,
      FAKE_UNITY_VERSION: cliVersion,
      ...(toolsInitiallyUnavailable ? { FAKE_UNITY_TOOLS_GATE_FILE: toolsGateFile } : {}),
      ...(toolsListDelayMs > 0 ? { FAKE_UNITY_TOOLS_LIST_DELAY_MS: String(toolsListDelayMs) } : {}),
      ...(notifyDuringToolsList ? { FAKE_UNITY_NOTIFY_DURING_TOOLS_LIST_ONCE: '1' } : {}),
      ...(notifyAfterTerminalStatusMs > 0
        ? { FAKE_UNITY_NOTIFY_AFTER_TERMINAL_STATUS_MS: String(notifyAfterTerminalStatusMs) }
        : {}),
      ...(initializeDelayOnceMs > 0
        ? { FAKE_UNITY_INITIALIZE_DELAY_ONCE_MS: String(initializeDelayOnceMs) }
        : {}),
      ...(toolCatalogFileEnabled ? { FAKE_UNITY_TOOL_CATALOG_FILE: toolCatalogFile } : {}),
      ...(cliVersionDelayMs > 0 ? { FAKE_UNITY_VERSION_DELAY_MS: String(cliVersionDelayMs) } : {}),
    },
  };
}

async function stopBroker(harness) {
  let pid;
  try { pid = JSON.parse(await readFile(harness.pidPath, 'utf8')).pid; } catch { return; }
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await waitUntil(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { timeoutMs: 5_000, message: `broker ${pid} to stop` }).catch(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  });
}

function assertSerialized(events, markers) {
  const relevant = events.filter((event) => markers.includes(event.marker));
  const positions = new Map(relevant.map((event, index) => [`${event.kind}:${event.marker}`, index]));
  assert(positions.has(`call-start:${markers[0]}`));
  assert(positions.has(`call-end:${markers[0]}`));
  assert(positions.has(`call-start:${markers[1]}`));
  assert(positions.has(`call-end:${markers[1]}`));
  const first = positions.get(`call-start:${markers[0]}`) < positions.get(`call-start:${markers[1]}`)
    ? markers[0] : markers[1];
  const second = first === markers[0] ? markers[1] : markers[0];
  assert(
    positions.get(`call-end:${first}`) < positions.get(`call-start:${second}`),
    `${first} and ${second} overlapped unexpectedly: ${JSON.stringify(relevant)}`,
  );
}

test('an initially unavailable Editor still exposes broker tools and later announces Unity tools', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ toolsInitiallyUnavailable: true });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await client.initialize();
  const initial = await client.request('tools/list');
  const initialNames = initial.result?.tools?.map((tool) => tool.name) ?? [];
  assert(initialNames.includes('unity_router_status'));
  assert(!initialNames.includes('editor_status'));
  client.notifications.length = 0;

  await writeFile(harness.toolsGateFile, 'ready');
  await client.waitForNotification('notifications/tools/list_changed', 12_000);
  const refreshed = await client.request('tools/list');
  assert(refreshed.result?.tools?.some((tool) => tool.name === 'editor_status'));
});

test('initialize rejects malformed params and advertises every forwarded capability', { timeout: 15_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  const preInitPing = await client.request('ping');
  assert.deepEqual(preInitPing.result, {});
  for (const [method, params] of [
    ['tools/list', {}],
    ['resources/list', {}],
    ['tools/call', { name: 'editor_status', arguments: {} }],
  ]) {
    const premature = await client.request(method, params);
    assert.equal(premature.error?.code, -32002);
  }
  assert.equal((await readEvents(harness.stateFile)).filter((event) => event.kind === 'spawn').length, 0);

  const missingVersion = await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'malformed', version: '1' },
  });
  assert.equal(missingVersion.error?.code, -32602);
  const nonStringVersion = await client.request('initialize', {
    protocolVersion: 20250618,
    capabilities: {},
    clientInfo: { name: 'malformed', version: '1' },
  });
  assert.equal(nonStringVersion.error?.code, -32602);

  const initialized = await client.initialize('2025-11-25', 'future-client');
  assert.equal(initialized.result?.protocolVersion, '2025-06-18');
  const repeated = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'repeat', version: '1' },
  });
  assert.equal(repeated.error?.code, -32600);
});

test('Codex and Claude protocol requests negotiate one frozen downstream revision and share one child', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness();
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  const initialized = await Promise.all([
    clients[0].initialize('2025-06-18', 'codex'),
    clients[1].initialize('2025-11-25', 'claude-code'),
    clients[2].initialize('malformed-future-version', 'future-client'),
  ]);
  assert.deepEqual(initialized.map((entry) => entry.result?.protocolVersion), [
    '2025-06-18',
    '2025-06-18',
    '2025-06-18',
  ]);
  await Promise.all(clients.map((client) => client.request('tools/list')));
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'spawn' && event.projectPath === harness.projectA).length, 1);
});

test('successful recompile refresh is exact, project-scoped, async-aware, and deduplicated', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await Promise.all(clients.map((client) => client.initialize()));
  await Promise.all(clients.map((client) => client.request('tools/list')));
  const countChanged = (client) => client.notifications
    .filter((message) => message.method === 'notifications/tools/list_changed').length;
  const clearNotifications = () => {
    for (const client of clients) client.notifications.length = 0;
  };
  const assertProjectAOnly = async () => {
    await waitUntil(() => countChanged(clients[0]) === 1 && countChanged(clients[1]) === 1, {
      timeoutMs: 4_000,
      message: 'one list_changed notification for each project A client',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(countChanged(clients[0]), 1);
    assert.equal(countChanged(clients[1]), 1);
    assert.equal(countChanged(clients[2]), 0);
  };

  // beta.3 can complete synchronously with JSON text only.
  clearNotifications();
  const sync = await clients[0].request('tools/call', {
    name: 'recompile', arguments: { mode: 'sync_success', marker: 'sync-success' },
  });
  assert.equal(sync.result?.structuredContent?.routerOperationState, 'COMPLETED');
  await assertProjectAOnly();

  // The client may immediately rediscover after the synthetic success signal
  // and only then receive the official child's late domain-reload event. If
  // the catalog is unchanged, that late event is the same generation.
  clearNotifications();
  await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: {
      mode: 'sync_success',
      notifyToolsChangedAfterMs: 150,
      marker: 'sync-synthetic-then-late-child',
    },
  });
  await assertProjectAOnly();
  await clients[0].request('tools/list');
  const syncLateBefore = (await readEvents(harness.stateFile)).filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(clients.map(countChanged), [1, 1, 0]);
  const syncLateEvents = await readEvents(harness.stateFile);
  assert(syncLateEvents.some((event) =>
    event.kind === 'tools-list-changed-notify'
    && event.marker === 'sync-synthetic-then-late-child'));
  assert.equal(syncLateEvents.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, syncLateBefore + 1);

  // A child-originated refresh before the terminal response already did the
  // invalidation and broadcast; the broker completion hook must not duplicate it.
  clearNotifications();
  await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: { mode: 'sync_success', notifyToolsChanged: true, marker: 'sync-child-notified' },
  });
  await assertProjectAOnly();

  // beta.3/Pipeline can report success before its domain-reload notification.
  // The synthetic refresh and one or more later child refreshes still form one
  // invalidation generation until a client rediscovers the catalog.
  clearNotifications();
  await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: {
      mode: 'sync_success',
      notifyToolsChanged: true,
      notifyToolsChangedAfterMs: 10,
      marker: 'sync-child-notified-before-and-after',
    },
  });
  await assertProjectAOnly();

  clearNotifications();
  await clients[0].request('tools/list');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(clients.map(countChanged), [0, 0, 0]);

  for (const mode of ['up_to_date', 'failed', 'errors', 'missing', 'ambiguous']) {
    clearNotifications();
    await clients[0].request('tools/call', {
      name: 'recompile', arguments: { mode, marker: `negative-${mode}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(clients.map(countChanged), [0, 0, 0], `unexpected notification for ${mode}`);
  }

  // The active trigger is not a completion. The terminal status observed by
  // the background tracker is what invalidates and announces.
  clearNotifications();
  const tracked = await clients[0].request('tools/call', {
    name: 'recompile', arguments: { mode: 'async_success', delayMs: 40, marker: 'async-success' },
  });
  assert.equal(tracked.result?.structuredContent?.routerOperationState, 'RUNNING');
  assert.deepEqual(clients.map(countChanged), [0, 0, 0]);
  await assertProjectAOnly();

  clearNotifications();
  const asyncLate = await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: {
      mode: 'async_success',
      delayMs: 40,
      notifyToolsChangedAfterMs: 1_400,
      marker: 'async-synthetic-then-late-child',
    },
  });
  assert.equal(asyncLate.result?.structuredContent?.routerOperationState, 'RUNNING');
  await assertProjectAOnly();
  await clients[0].request('tools/list');
  const asyncLateBefore = (await readEvents(harness.stateFile)).filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(clients.map(countChanged), [1, 1, 0]);
  const asyncLateEvents = await readEvents(harness.stateFile);
  assert(asyncLateEvents.some((event) =>
    event.kind === 'tools-list-changed-notify'
    && event.marker === 'async-synthetic-then-late-child'));
  assert.equal(asyncLateEvents.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, asyncLateBefore + 1);

  // The same deduplication rule also applies to the background terminal path.
  clearNotifications();
  const childNotified = await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: { mode: 'async_success', delayMs: 40, notifyToolsChanged: true, marker: 'async-child-notified' },
  });
  assert.equal(childNotified.result?.structuredContent?.routerOperationState, 'RUNNING');
  await assertProjectAOnly();

  const beforeRediscovery = await readEvents(harness.stateFile);
  const beforeA = beforeRediscovery.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length;
  const beforeB = beforeRediscovery.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectB).length;
  await clients[2].request('tools/list');
  await clients[0].request('tools/list');
  const afterRediscovery = await readEvents(harness.stateFile);
  assert.equal(afterRediscovery.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectB).length, beforeB);
  assert.equal(afterRediscovery.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, beforeA + 1);
});

test('successful recompile does not commit a transient empty catalog while Pipeline restarts', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ toolsInitiallyUnavailable: true });
  await writeFile(harness.toolsGateFile, 'ready');
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await Promise.all(clients.map((client) => client.initialize()));
  const initial = await Promise.all(clients.map((client) => client.request('tools/list')));
  assert(initial[0].result?.tools?.some((entry) => entry.name === 'editor_status'));
  const baselineStatus = await clients[0].request('tools/call', {
    name: 'unity_router_status', arguments: {},
  });
  const baselineProject = baselineStatus.result?.structuredContent?.projects?.find((entry) => entry.name === 'a');
  assert.match(baselineProject?.tools ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(baselineProject.tools, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const beforeRecoveryEvents = await readEvents(harness.stateFile);
  const beforeRecoveryLists = beforeRecoveryEvents.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length;
  for (const client of clients) client.notifications.length = 0;
  await rm(harness.toolsGateFile);

  await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: { mode: 'sync_success', notifyToolsChanged: true, marker: 'empty-during-pipeline-restart' },
  });
  await Promise.all([
    clients[0].waitForNotification('notifications/tools/list_changed', 5_000),
    clients[1].waitForNotification('notifications/tools/list_changed', 5_000),
  ]);

  const restore = new Promise((resolve, reject) => {
    setTimeout(() => {
      writeFile(harness.toolsGateFile, 'ready').then(resolve, reject);
    }, 350);
  });
  const relisted = await Promise.all([
    clients[0].request('tools/list', {}, { timeoutMs: 10_000 }),
    clients[1].request('tools/list', {}, { timeoutMs: 10_000 }),
  ]);
  await restore;
  assert(relisted.every((response) =>
    response.result?.tools?.some((entry) => entry.name === 'editor_status')));
  assert.deepEqual(
    relisted[0].result.tools.map((entry) => entry.name).sort(),
    relisted[1].result.tools.map((entry) => entry.name).sort(),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(clients.map((client) => client.notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length), [1, 1, 0]);

  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length - beforeRecoveryLists, 3);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'empty-during-pipeline-restart').length, 1);
  const finalStatus = await clients[0].request('tools/call', {
    name: 'unity_router_status', arguments: {},
  });
  const finalProject = finalStatus.result?.structuredContent?.projects?.find((entry) => entry.name === 'a');
  assert.equal(finalProject?.tools, baselineProject.tools);
  assert.equal(finalProject?.child?.pid, baselineProject.child?.pid);
});

test('tool discovery discards a catalog invalidated while its request is in flight', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ toolsListDelayMs: 180, notifyDuringToolsList: true });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await client.initialize();
  const listed = await client.request('tools/list', {}, { timeoutMs: 15_000 });
  assert(listed.result?.tools?.some((entry) => entry.name === 'editor_status'));
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'tools-list').length, 2);
  assert.equal(client.notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 1);
});

test('late changed-only reannounce survives an immediate child exit and recovery retry', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ toolsListDelayMs: 250, toolCatalogFileEnabled: true });
  await writeFile(harness.toolCatalogFile, 'v1');
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((client) => client.initialize()));
  await Promise.all(clients.map((client) => client.request('tools/list')));
  for (const client of clients) client.notifications.length = 0;

  await clients[0].request('tools/call', {
    name: 'recompile',
    arguments: {
      mode: 'sync_success',
      notifyToolsChangedAfterMs: 700,
      exitAfterToolsChangedMs: 25,
      marker: 'late-notify-immediate-exit',
    },
  });
  await clients[0].waitForNotification('notifications/tools/list_changed', 5_000);
  await clients[0].request('tools/list');
  for (const client of clients) client.notifications.length = 0;
  await writeFile(harness.toolCatalogFile, 'v2');

  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'tools-list-changed-notify'
    && event.marker === 'late-notify-immediate-exit'), {
    timeoutMs: 5_000,
    message: 'late list_changed before child exit',
  });
  await clients[0].waitForNotification('notifications/tools/list_changed', 10_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(clients[0].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 1);
  assert.equal(clients[1].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 0);
  const recovered = await clients[0].request('tools/list');
  assert.equal(recovered.result?.tools?.find((entry) => entry.name === 'editor_status')?.description, 'Fake safe read v2');
});

test('an unexpected idle child exit rediscoveries only that project before announcing', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await Promise.all(clients.map((client) => client.initialize()));
  await Promise.all(clients.map((client) => client.request('tools/list')));
  for (const client of clients) client.notifications.length = 0;

  const status = await clients[0].request('tools/call', {
    name: 'editor_status',
    arguments: { exitAfterResponseMs: 50, marker: 'idle-child-exit' },
  });
  assert.equal(status.result?.isError, false);
  await clients[0].waitForNotification('notifications/tools/list_changed', 15_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(clients[0].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 1);
  assert.equal(clients[1].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 0);
  const relisted = await clients[0].request('tools/list');
  assert(relisted.result?.tools?.some((entry) => entry.name === 'editor_status'));

  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'spawn' && event.projectPath === harness.projectA).length, 2);
  assert.equal(events.filter((event) => event.kind === 'spawn' && event.projectPath === harness.projectB).length, 1);
});

test('lifecycle recovery keeps its project-scoped announcement until a non-empty catalog returns', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ toolsInitiallyUnavailable: true });
  await writeFile(harness.toolsGateFile, 'ready');
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await Promise.all(clients.map((client) => client.initialize()));
  await Promise.all(clients.map((client) => client.request('tools/list')));
  for (const client of clients) client.notifications.length = 0;
  await rm(harness.toolsGateFile);

  await clients[0].request('tools/call', {
    name: 'editor_status',
    arguments: { exitAfterResponseMs: 50, marker: 'recovery-empty-first' },
  });
  await waitUntil(async () => (await readEvents(harness.stateFile)).filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length >= 2, {
    timeoutMs: 10_000,
    message: 'empty lifecycle rediscovery',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(clients[0].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 0);
  assert.equal(clients[1].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 0);

  await writeFile(harness.toolsGateFile, 'ready');
  const recovered = await clients[0].request('tools/list');
  assert(recovered.result?.tools?.some((entry) => entry.name === 'editor_status'));
  await waitUntil(() => clients[0].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length === 1, {
    timeoutMs: 5_000,
    message: 'deferred lifecycle recovery announcement',
  });
  assert.equal(clients[1].notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 0);
});

test('expected idle stop invalidates the cache and forces a fresh child on the next list', { timeout: 15_000 }, async (t) => {
  const harness = await createHarness({ childIdleMin: 0.001 });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await client.initialize();
  await client.request('tools/list');
  client.notifications.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  const relisted = await client.request('tools/list', {}, { timeoutMs: 10_000 });
  assert(relisted.result?.tools?.some((entry) => entry.name === 'editor_status'));
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'spawn' && event.projectPath === harness.projectA).length, 2);
  assert.equal(client.notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 0);
});

test('tools/list cancellation is waiter-scoped and reaches Unity only for the last waiter', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ toolsListDelayMs: 600 });
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((client) => client.initialize()));

  const preflightCancelled = clients[0].request('tools/list', {}, { id: 8100, timeoutMs: 10_000 });
  clients[0].notify('notifications/cancelled', { requestId: 8100, reason: 'preflight waiter cancelled' });
  assert.equal((await preflightCancelled).error?.code, -32800);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await readEvents(harness.stateFile)).filter((event) =>
    event.kind === 'spawn' && event.projectPath === harness.projectA).length, 0);

  const cancelledWaiter = clients[0].request('tools/list', {}, { id: 8101, timeoutMs: 10_000 });
  const survivingWaiter = clients[1].request('tools/list', {}, { id: 8102, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA), {
    timeoutMs: 5_000,
    message: 'shared tools/list dispatch',
  });
  clients[0].notify('notifications/cancelled', { requestId: 8101, reason: 'one waiter cancelled' });
  const cancelled = await cancelledWaiter;
  const survived = await survivingWaiter;
  assert.equal(cancelled.error?.code, -32800);
  assert(survived.result?.tools?.some((entry) => entry.name === 'editor_status'));
  let events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'cancel' && event.reason === 'one waiter cancelled').length, 0);

  const lastWaiter = clients[2].request('tools/list', {}, { id: 8103, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectB), {
    timeoutMs: 5_000,
    message: 'single tools/list dispatch',
  });
  clients[2].notify('notifications/cancelled', { requestId: 8103, reason: 'last waiter cancelled' });
  const lastCancelled = await lastWaiter;
  assert.equal(lastCancelled.error?.code, -32800);
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'cancel' && event.reason === 'last waiter cancelled'), {
    timeoutMs: 5_000,
    message: 'last waiter child cancellation',
  });
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'spawn' && event.projectPath === harness.projectB).length, 1);
});

test('startup cancellation aborts delayed initialize without dispatching the downstream request', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ initializeDelayOnceMs: 5_000 });
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((client) => client.initialize()));

  const listPending = clients[0].request('tools/list', {}, { id: 8201, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'initialize-delay-once' && event.projectPath === harness.projectA), {
    timeoutMs: 5_000,
    message: 'delayed tools/list child initialize',
  });
  const listCancelledAt = Date.now();
  clients[0].notify('notifications/cancelled', { requestId: 8201, reason: 'cancel tools startup' });
  const listCancelled = await listPending;
  assert.equal(listCancelled.error?.code, -32800);
  assert(Date.now() - listCancelledAt < 2_000, 'tools/list startup cancellation must be prompt');

  const protocolPending = clients[1].request('resources/list', {}, { id: 8202, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'initialize-delay-once' && event.projectPath === harness.projectB), {
    timeoutMs: 5_000,
    message: 'delayed protocol-read child initialize',
  });
  const protocolCancelledAt = Date.now();
  clients[1].notify('notifications/cancelled', { requestId: 8202, reason: 'cancel protocol startup' });
  const protocolCancelled = await protocolPending;
  assert.equal(protocolCancelled.error?.code, -32800);
  assert(Date.now() - protocolCancelledAt < 2_000, 'protocol startup cancellation must be prompt');

  let events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, 0);
  assert.equal(events.filter((event) =>
    event.kind === 'protocol-start' && event.projectPath === harness.projectB).length, 0);

  const [listed, resources] = await Promise.all([
    clients[0].request('tools/list', {}, { timeoutMs: 10_000 }),
    clients[1].request('resources/list', {}, { timeoutMs: 10_000 }),
  ]);
  assert(listed.result?.tools?.some((entry) => entry.name === 'editor_status'));
  assert.deepEqual(resources.result, { resources: [] });
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, 1);
  assert.equal(events.filter((event) =>
    event.kind === 'protocol-start' && event.projectPath === harness.projectB).length, 1);
});

test('active queue deadlines cap child initialize and forbid a late downstream dispatch', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ deadlineSec: 0.4, initializeDelayOnceMs: 5_000 });
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((client) => client.initialize()));

  const listStartedAt = Date.now();
  const listed = await clients[0].request('tools/list', {}, { timeoutMs: 10_000 });
  assert(Date.now() - listStartedAt < 1_200, 'tools/list must not exceed its active queue deadline');
  assert(!listed.result?.tools?.some((entry) => entry.name === 'editor_status'));

  const callStartedAt = Date.now();
  const called = await clients[1].request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'must-not-dispatch-after-startup-deadline' },
  }, { timeoutMs: 10_000 });
  assert(Date.now() - callStartedAt < 1_200, 'tools/call must not exceed its active queue deadline');
  assert.equal(called.error?.data?.brokerCode, 'DEADLINE_EXCEEDED');

  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, 0);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'must-not-dispatch-after-startup-deadline').length, 0);
});

test('tools/call cancellation and adapter disconnect share the prompt cold-start abort path', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ initializeDelayOnceMs: 5_000 });
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((client) => client.initialize()));

  const preflightCall = clients[0].request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'cancelled-during-mutation-preflight' },
  }, { id: 8300, timeoutMs: 10_000 });
  clients[0].notify('notifications/cancelled', { requestId: 8300, reason: 'cancel mutation preflight' });
  const preflightCancelled = await preflightCall;
  assert.equal(preflightCancelled.result?.structuredContent?.state, 'CANCELLED');
  assert.equal((await readEvents(harness.stateFile)).filter((event) =>
    event.kind === 'mutation' && event.marker === 'cancelled-during-mutation-preflight').length, 0);

  const cancelledCall = clients[0].request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'cancelled-during-tool-startup' },
  }, { id: 8301, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'initialize-delay-once' && event.projectPath === harness.projectA), {
    timeoutMs: 5_000,
    message: 'delayed tools/call child initialize',
  });
  const cancelledAt = Date.now();
  clients[0].notify('notifications/cancelled', { requestId: 8301, reason: 'cancel tool startup' });
  const cancelled = await cancelledCall;
  assert.equal(cancelled.result?.structuredContent?.state, 'CANCELLED');
  assert(Date.now() - cancelledAt < 2_000, 'tools/call startup cancellation must be prompt');
  const afterCancel = await clients[1].request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'after-tool-startup-cancel' },
  }, { timeoutMs: 10_000 });
  assert.equal(afterCancel.result?.isError, false);

  const disconnectedCall = clients[2].request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'disconnected-during-tool-startup' },
  }, { id: 8302, timeoutMs: 10_000 }).catch(() => null);
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'initialize-delay-once' && event.projectPath === harness.projectB), {
    timeoutMs: 5_000,
    message: 'delayed disconnected child initialize',
  });
  const disconnectedAt = Date.now();
  await clients[2].close();
  const afterDisconnect = await clients[3].request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'after-tool-startup-disconnect' },
  }, { timeoutMs: 10_000 });
  await disconnectedCall;
  assert.equal(afterDisconnect.result?.isError, false);
  assert(Date.now() - disconnectedAt < 3_000, 'disconnect must release the project lane promptly');

  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'cancelled-during-tool-startup').length, 0);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'disconnected-during-tool-startup').length, 0);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'after-tool-startup-cancel').length, 1);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'after-tool-startup-disconnect').length, 1);
});

test('cross-project cancellation aborts both cold schema discoveries and releases both lanes', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ initializeDelayOnceMs: 5_000 });
  const clients = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((client) => client.initialize()));

  const pending = clients[0].request('tools/call', {
    name: 'editor_status',
    arguments: { project: 'b', marker: 'cross-cold-cancel' },
  }, { id: 8351, timeoutMs: 10_000 });
  await waitUntil(async () => {
    const events = await readEvents(harness.stateFile);
    return [harness.projectA, harness.projectB].every((projectPath) => events.some((event) =>
      event.kind === 'initialize-delay-once' && event.projectPath === projectPath));
  }, {
    timeoutMs: 5_000,
    message: 'both cross-project schema discoveries to enter delayed initialize',
  });

  const cancelledAt = Date.now();
  clients[0].notify('notifications/cancelled', {
    requestId: 8351,
    reason: 'cancel cross-project cold discovery',
  });
  const cancelled = await pending;
  assert.equal(cancelled.result?.structuredContent?.state, 'CANCELLED');
  assert(Date.now() - cancelledAt < 2_000, 'cross-project discovery cancellation must be prompt');

  const reuseStartedAt = Date.now();
  const [projectAResult, projectBResult] = await Promise.all([
    clients[1].request('tools/call', {
      name: 'editor_status',
      arguments: { marker: 'after-cross-cancel-a' },
    }, { timeoutMs: 10_000 }),
    clients[2].request('tools/call', {
      name: 'editor_status',
      arguments: { marker: 'after-cross-cancel-b' },
    }, { timeoutMs: 10_000 }),
  ]);
  assert.equal(projectAResult.result?.isError, false);
  assert.equal(projectBResult.result?.isError, false);
  assert(Date.now() - reuseStartedAt < 3_000, 'both project lanes must be reusable after cancellation');

  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'cross-cold-cancel').length, 0);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'after-cross-cancel-a').length, 1);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'after-cross-cancel-b').length, 1);
});

test('cross-project adapter disconnect aborts both cold schema discoveries and releases both lanes', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ initializeDelayOnceMs: 5_000 });
  const victim = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  const observers = [
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }),
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env }),
  ];
  t.after(async () => {
    await Promise.allSettled([victim.close(), ...observers.map((client) => client.close())]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([victim.initialize(), ...observers.map((client) => client.initialize())]);

  const abandoned = victim.request('tools/call', {
    name: 'editor_status',
    arguments: { project: 'b', marker: 'cross-cold-disconnect' },
  }, { id: 8352, timeoutMs: 10_000 }).catch(() => null);
  await waitUntil(async () => {
    const events = await readEvents(harness.stateFile);
    return [harness.projectA, harness.projectB].every((projectPath) => events.some((event) =>
      event.kind === 'initialize-delay-once' && event.projectPath === projectPath));
  }, {
    timeoutMs: 5_000,
    message: 'both disconnected cross-project discoveries to enter delayed initialize',
  });

  const disconnectedAt = Date.now();
  await victim.close();
  const [projectAResult, projectBResult] = await Promise.all([
    observers[0].request('tools/call', {
      name: 'editor_status',
      arguments: { marker: 'after-cross-disconnect-a' },
    }, { timeoutMs: 10_000 }),
    observers[1].request('tools/call', {
      name: 'editor_status',
      arguments: { marker: 'after-cross-disconnect-b' },
    }, { timeoutMs: 10_000 }),
  ]);
  await abandoned;
  assert.equal(projectAResult.result?.isError, false);
  assert.equal(projectBResult.result?.isError, false);
  assert(Date.now() - disconnectedAt < 3_000, 'disconnect must release both project lanes promptly');

  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'cross-cold-disconnect').length, 0);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'after-cross-disconnect-a').length, 1);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'after-cross-disconnect-b').length, 1);
});

test('adapter disconnect during mutation preflight cannot journal or dispatch the mutation', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ cliVersionDelayMs: 700 });
  const victim = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  const observer = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await Promise.allSettled([victim.close(), observer.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([victim.initialize(), observer.initialize()]);

  const abandoned = victim.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'disconnect-during-mutation-preflight' },
  }, { id: 8401, timeoutMs: 10_000 }).catch(() => null);
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'version-start' && event.delayMs === 700), {
    timeoutMs: 5_000,
    message: 'delayed mutation preflight',
  });
  await victim.close();
  await abandoned;
  await new Promise((resolve) => setTimeout(resolve, 800));

  let events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'mutation' && event.marker === 'disconnect-during-mutation-preflight').length, 0);
  const after = await observer.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'after-mutation-preflight-disconnect' },
  }, { timeoutMs: 10_000 });
  assert.equal(after.result?.isError, false);
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'mutation' && event.marker === 'after-mutation-preflight-disconnect').length, 1);
});

test('forwarded protocol reads retry once and propagate post-dispatch cancellation', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  await client.initialize();
  const retried = await client.request('resources/list', { failOnce: 'protocol-read-once' }, { timeoutMs: 15_000 });
  assert.deepEqual(retried.result, { resources: [] });
  const retryEvents = await readEvents(harness.stateFile);
  assert.equal(retryEvents.filter((event) => event.kind === 'protocol-fail-once').length, 1);
  assert.equal(retryEvents.filter((event) =>
    event.kind === 'protocol-end' && event.method === 'resources/list').length, 1);

  const blocker = client.request('resources/list', {
    delayMs: 500,
    marker: 'queued-cancel-blocker',
  }, { id: 7000, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'protocol-start' && event.marker === 'queued-cancel-blocker'), {
    timeoutMs: 5_000,
    message: 'queued cancellation blocker dispatch',
  });
  const queued = client.request('resources/list', {
    marker: 'must-not-dispatch-after-queued-cancel',
  }, { id: 7002, timeoutMs: 10_000 });
  client.notify('notifications/cancelled', { requestId: 7002, reason: 'queued protocol cancellation' });
  const queuedCancelled = await queued;
  assert.equal(queuedCancelled.error?.code, -32800);
  await blocker;
  const queuedEvents = await readEvents(harness.stateFile);
  assert.equal(queuedEvents.filter((event) =>
    event.kind === 'protocol-start' && event.marker === 'must-not-dispatch-after-queued-cancel').length, 0);

  const requestId = 7001;
  const pending = client.request(
    'resources/list',
    { delayMs: 2_000, cancelMode: 'error', marker: 'cancel-protocol-read' },
    { id: requestId, timeoutMs: 10_000 },
  );
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'protocol-start' && event.marker === 'cancel-protocol-read'), {
    timeoutMs: 5_000,
    message: 'forwarded protocol read dispatch',
  });
  client.notify('notifications/cancelled', { requestId, reason: 'integration cancellation' });
  const cancelled = await pending;
  assert.equal(cancelled.error?.code, -32800);
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'cancel'), {
    timeoutMs: 5_000,
    message: 'child cancellation frame',
  });
});

test('expected retry replacement invalidates a warm tool cache before the next list', { timeout: 15_000 }, async (t) => {
  const harness = await createHarness({ deadlineSec: 0.4, toolCatalogFileEnabled: true });
  await writeFile(harness.toolCatalogFile, 'v1');
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  const initial = await client.request('tools/list');
  assert.equal(initial.result?.tools?.find((entry) => entry.name === 'editor_status')?.description, 'Fake safe read v1');
  client.notifications.length = 0;
  await writeFile(harness.toolCatalogFile, 'v2');

  const timedOut = await client.request('resources/list', {
    delayMs: 2_000,
    marker: 'expected-protocol-replacement',
  }, { timeoutMs: 10_000 });
  assert.equal(timedOut.error?.data?.brokerCode, 'DEADLINE_EXCEEDED');
  const refreshed = await client.request('tools/list', {}, { timeoutMs: 10_000 });
  assert.equal(refreshed.result?.tools?.find((entry) => entry.name === 'editor_status')?.description, 'Fake safe read v2');
  assert.equal(client.notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 1);
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'spawn' && event.projectPath === harness.projectA).length, 2);
});

test('protocol cancellation near the transport deadline prevents the retry', { timeout: 15_000 }, async (t) => {
  const harness = await createHarness({ deadlineSec: 0.25 });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();

  const pending = client.request('resources/list', {
    delayMs: 2_000,
    cancelMode: 'ignore',
    marker: 'cancel-during-protocol-stop',
  }, { id: 7003, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'protocol-start' && event.marker === 'cancel-during-protocol-stop'), {
    timeoutMs: 5_000,
    message: 'protocol request before cleanup cancellation',
  });
  // The project access probe intentionally consumes part of the same queue
  // deadline, so cancel after dispatch but before the remaining transport
  // budget expires.
  await new Promise((resolve) => setTimeout(resolve, 80));
  client.notify('notifications/cancelled', { requestId: 7003, reason: 'cancel near deadline' });
  const cancelled = await pending;
  assert.equal(cancelled.error?.code, -32800);
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'protocol-start' && event.marker === 'cancel-during-protocol-stop').length, 1);
});

test('shared daemon isolates projects, serializes mutations, retries reads, and never replays unknown mutations', { timeout: 45_000 }, async (t) => {
  const harness = await createHarness();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  // Simultaneous auto-start attempts exercise the machine singleton path.
  for (let index = 0; index < 8; index += 1) {
    clients.push(new StdioMcpClient({
      configPath: harness.configPath,
      defaultProject: 'a',
      env: harness.env,
      admin: index === 0,
    }));
  }
  await Promise.all(clients.map((client) => client.initialize()));
  await Promise.all(clients.map((client) => client.request('tools/list')));

  let events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'spawn' && event.projectPath === harness.projectA).length, 1);
  const statusA = await clients[0].request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(statusA.result?.structuredContent?.broker?.clients, 8);
  const brokerPid = statusA.result?.structuredContent?.broker?.pid;
  assert(Number.isSafeInteger(brokerPid));

  // Same physical project is single-flight even across different agent clients.
  await Promise.all([
    clients[0].request('tools/call', { name: 'editor_status', arguments: { delayMs: 120, marker: 'same-a-1' } }),
    clients[1].request('tools/call', { name: 'editor_status', arguments: { delayMs: 120, marker: 'same-a-2' } }),
  ]);
  events = await readEvents(harness.stateFile);
  assertSerialized(events, ['same-a-1', 'same-a-2']);

  // The next queued mutation waits for the prior adapter delivery ACK; it is
  // not rejected in the small window between Unity completion and ACK.
  const sameProjectMutations = await Promise.all([
    clients[0].request('tools/call', {
      name: 'mutate_once', arguments: { delayMs: 80, marker: 'same-mutation-a-1' },
    }),
    clients[1].request('tools/call', {
      name: 'mutate_once', arguments: { delayMs: 80, marker: 'same-mutation-a-2' },
    }),
  ]);
  assert(sameProjectMutations.every((response) => response.result?.isError !== true));
  events = await readEvents(harness.stateFile);
  assertSerialized(events, ['same-mutation-a-1', 'same-mutation-a-2']);

  const clientB = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env });
  clients.push(clientB);
  await clientB.initialize();
  await clientB.request('tools/list');

  // Light reads on different projects overlap.
  await Promise.all([
    clients[0].request('tools/call', { name: 'editor_status', arguments: { delayMs: 220, marker: 'parallel-a' } }),
    clientB.request('tools/call', { name: 'editor_status', arguments: { delayMs: 220, marker: 'parallel-b' } }),
  ]);
  events = await readEvents(harness.stateFile);
  const parallel = events.filter((event) => event.marker === 'parallel-a' || event.marker === 'parallel-b');
  const starts = parallel.filter((event) => event.kind === 'call-start');
  const ends = parallel.filter((event) => event.kind === 'call-end');
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert(Math.max(...starts.map((event) => event.at)) < Math.min(...ends.map((event) => event.at)), JSON.stringify(parallel));

  // Heavy/unknown mutations are globally serialized across projects.
  await Promise.all([
    clients[0].request('tools/call', { name: 'mutate_once', arguments: { delayMs: 120, marker: 'heavy-a' } }),
    clientB.request('tools/call', { name: 'mutate_once', arguments: { delayMs: 120, marker: 'heavy-b' } }),
  ]);
  events = await readEvents(harness.stateFile);
  assertSerialized(events, ['heavy-a', 'heavy-b']);

  // A dispatched safe read may be retried once after the child disappears.
  const retry = await clients[0].request('tools/call', {
    name: 'editor_status',
    arguments: { failOnce: 'safe-read-1', marker: 'safe-read-retry' },
  });
  assert.equal(retry.result?.isError, false);
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'fail-once' && event.key === 'safe-read-1').length, 1);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'safe-read-retry').length, 2);

  // A dispatched mutation that loses transport is recorded UNKNOWN_OUTCOME and
  // is never replayed automatically.
  const beforeMutation = events.filter((event) => event.kind === 'mutation').length;
  const unknown = await clientB.request('tools/call', {
    name: 'mutate_once',
    arguments: { dropAfterDispatch: true, marker: 'unknown-mutation' },
  });
  assert.equal(unknown.result?.isError, true);
  assert.equal(unknown.result?.structuredContent?.state, 'UNKNOWN_OUTCOME');
  const operationId = unknown.result?.structuredContent?.operationId;
  assert.equal(typeof operationId, 'string');
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'mutation').length, beforeMutation + 1);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'unknown-mutation').length, 1);
  const operationStatus = await clients[0].request('tools/call', {
    name: 'unity_router_operation_status',
    arguments: { operationId },
  });
  assert.equal(operationStatus.result?.structuredContent?.state, 'UNKNOWN_OUTCOME');
  const fenced = await clientB.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'must-be-fenced' },
  });
  assert.equal(fenced.result?.structuredContent?.code, 'PROJECT_UNKNOWN_OUTCOME_FENCE');
  const resolved = await clients[0].request('tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: { operationId, resolution: 'safe_to_retry' },
  });
  assert.equal(resolved.result?.structuredContent?.state, 'RESOLVED');
  const afterResolution = await clientB.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'after-resolution' },
  });
  assert.equal(afterResolution.result?.isError, false);

  // Cancellation of queued work prevents dispatch.
  const active = clients[0].request('tools/call', {
    name: 'editor_status',
    arguments: { delayMs: 250, marker: 'cancel-blocker' },
  }, { id: 50 });
  const queued = clients[1].request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'must-not-dispatch' },
  }, { id: 51 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  clients[1].notify('notifications/cancelled', { requestId: 51, reason: 'integration test' });
  const [, cancelled] = await Promise.all([active, queued]);
  assert.equal(cancelled.result?.structuredContent?.state, 'CANCELLED');
  const cancelledStatus = await clients[0].request('tools/call', {
    name: 'unity_router_operation_status',
    arguments: { operationId: cancelled.result?.structuredContent?.operationId },
  });
  assert.equal(cancelledStatus.result?.structuredContent?.state, 'CANCELLED');
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'must-not-dispatch').length, 0);

  // Child notifications invalidate the cache and reach attached clients.
  for (const client of clients) client.notifications.length = 0;
  await clients[0].request('tools/call', {
    name: 'mutate_once',
    arguments: { notifyToolsChanged: true, marker: 'tools-changed' },
  });
  await clients[2].waitForNotification('notifications/tools/list_changed');

  // Arbitrary child notifications have no durable request correlation and
  // must not be guessed onto either the active client or another session.
  for (const client of clients) client.notifications.length = 0;
  await clients[0].request('tools/call', {
    name: 'mutate_once',
    arguments: { notifyPrivate: true, marker: 'private-notification' },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(clients.every((client) =>
    !client.notifications.some((message) => message.method === 'notifications/message')));

  // Closing one adapter never tears down the shared project child.
  const beforeClose = await clients[1].request('tools/call', { name: 'unity_router_status', arguments: {} });
  const childPid = beforeClose.result?.structuredContent?.projects
    ?.find((project) => project.name === 'a')?.child?.pid;
  await clients[0].close();
  const afterClose = await clients[1].request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(afterClose.result?.structuredContent?.broker?.pid, brokerPid);
  assert.equal(afterClose.result?.structuredContent?.projects
    ?.find((project) => project.name === 'a')?.child?.pid, childPid);
});

test('broker crash is rediscovered without replaying an in-flight mutation', { timeout: 30_000 }, async (t) => {
  const harness = await createHarness();
  const clients = Array.from({ length: 4 }, () =>
    new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }));
  const client = clients[0];
  t.after(async () => {
    await Promise.allSettled(clients.map((entry) => entry.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all(clients.map((entry) => entry.initialize()));
  await client.request('tools/list');
  for (const entry of clients) entry.notifications.length = 0;

  const inFlight = client.request('tools/call', {
    name: 'mutate_once',
    arguments: { delayMs: 2_000, marker: 'broker-crash-mutation' },
  }, { id: 77, timeoutMs: 15_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'mutation' && event.marker === 'broker-crash-mutation'), {
    timeoutMs: 5_000,
    message: 'mutation dispatch before broker crash',
  });
  const oldPid = JSON.parse(await readFile(harness.pidPath, 'utf8')).pid;
  process.kill(oldPid, 'SIGKILL');

  const lost = await inFlight;
  assert.equal(lost.error?.code, -32074);
  await Promise.all(clients.map((entry) => entry.waitForNotification('notifications/tools/list_changed', 15_000)));
  await waitUntil(async () => {
    try { return JSON.parse(await readFile(harness.pidPath, 'utf8')).pid !== oldPid; } catch { return false; }
  }, { timeoutMs: 15_000, message: 'replacement broker pid' });

  const status = await clients[1].request('tools/call', {
    name: 'unity_router_status',
    arguments: {},
  }, { timeoutMs: 15_000 });
  const unknown = status.result?.structuredContent?.unknownOutcomes ?? [];
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].state, 'UNKNOWN_OUTCOME');
  assert.equal(unknown[0].method, 'mutate_once');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'mutation').length, 1);
});

test('timed-out mutation quarantines its child and fences the project before later writes', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ toolTimeoutSec: 0.1, deadlineSec: 3 });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');

  const timedOut = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { delayMs: 600, marker: 'timed-out-first' },
  });
  assert.equal(timedOut.result?.structuredContent?.state, 'UNKNOWN_OUTCOME');
  const operationId = timedOut.result?.structuredContent?.operationId;

  const blocked = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'blocked-second' },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'PROJECT_UNKNOWN_OUTCOME_FENCE');
  const read = await client.request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'read-during-fence' },
  });
  assert.equal(read.result?.isError, false);
  let events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'blocked-second').length, 0);

  await client.request('tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: { operationId, resolution: 'abandoned' },
  });
  const after = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'write-after-resolution' },
  });
  assert.equal(after.result?.isError, false);
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'write-after-resolution').length, 1);
});

test('post-dispatch cancellation is ordered and fences only an ambiguous mutation outcome', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');

  const ambiguousPromise = client.request('tools/call', {
    name: 'mutate_once',
    arguments: { delayMs: 1_000, cancelMode: 'error', marker: 'cancel-error-mutation' },
  }, { id: 90, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'call-start' && event.marker === 'cancel-error-mutation'), {
    message: 'cancel-error mutation dispatch',
  });
  client.notify('notifications/cancelled', { requestId: 90, reason: 'integration cancellation' });
  const ambiguous = await ambiguousPromise;
  assert.equal(ambiguous.result?.structuredContent?.state, 'UNKNOWN_OUTCOME');
  assert.equal(ambiguous.result?.structuredContent?.code, 'CANCELLED_AFTER_DISPATCH');
  const operationId = ambiguous.result?.structuredContent?.operationId;
  let events = await readEvents(harness.stateFile);
  const callIndex = events.findIndex((event) => event.kind === 'call-start' && event.marker === 'cancel-error-mutation');
  const cancelIndex = events.findIndex((event) => event.kind === 'cancel' && event.reason === 'integration cancellation');
  assert(callIndex >= 0 && cancelIndex > callIndex, JSON.stringify(events));

  await client.request('tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: { operationId, resolution: 'abandoned' },
  });

  const structuredPromise = client.request('tools/call', {
    name: 'mutate_once',
    arguments: { delayMs: 1_000, cancelMode: 'result', marker: 'cancel-result-mutation' },
  }, { id: 92, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'call-start' && event.marker === 'cancel-result-mutation'), {
    message: 'structured cancellation mutation dispatch',
  });
  client.notify('notifications/cancelled', { requestId: 92, reason: 'structured cancellation' });
  const structured = await structuredPromise;
  assert.equal(structured.result?.structuredContent?.state, 'UNKNOWN_OUTCOME');
  await client.request('tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: {
      operationId: structured.result?.structuredContent?.operationId,
      resolution: 'abandoned',
    },
  });

  const successfulPromise = client.request('tools/call', {
    name: 'mutate_once',
    arguments: { delayMs: 120, cancelMode: 'ignore', marker: 'cancel-ignored-success' },
  }, { id: 91, timeoutMs: 10_000 });
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'call-start' && event.marker === 'cancel-ignored-success'), {
    message: 'cancel-ignored mutation dispatch',
  });
  client.notify('notifications/cancelled', { requestId: 91, reason: 'ignored cancellation' });
  const successful = await successfulPromise;
  assert.equal(successful.result?.isError, false);
  const status = await client.request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(status.result?.structuredContent?.unknownOutcomes?.length, 0);
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'mutation' && event.marker === 'cancel-ignored-success').length, 1);
});

test('adapter disconnect after dispatch promptly quarantines an ignored mutation and fences without replay', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness({ toolTimeoutSec: 300, deadlineSec: 300 });
  const victim = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  const observer = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await Promise.allSettled([victim.close(), observer.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([victim.initialize(), observer.initialize()]);
  await Promise.all([victim.request('tools/list'), observer.request('tools/list')]);
  const inFlight = victim.request('tools/call', {
    name: 'mutate_once',
    arguments: { delayMs: 8_000, cancelMode: 'ignore', marker: 'disconnect-cancel-mutation' },
  }, { id: 93, timeoutMs: 10_000 }).catch(() => null);
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'call-start' && event.marker === 'disconnect-cancel-mutation'), {
    message: 'disconnect mutation dispatch',
  });
  const disconnectedAt = Date.now();
  await victim.close();
  const releasedRead = observer.request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'read-after-disconnect-quarantine' },
  }, { timeoutMs: 10_000 });
  await inFlight;
  const read = await releasedRead;
  assert.equal(read.result?.isError, false);
  assert(Date.now() - disconnectedAt < 3_000, 'disconnect quarantine must promptly release the project lane');

  const unknown = await waitUntil(async () => {
    const status = await observer.request('tools/call', { name: 'unity_router_status', arguments: {} });
    return status.result?.structuredContent?.unknownOutcomes?.find((operation) =>
      operation.method === 'mutate_once' && operation.state === 'UNKNOWN_OUTCOME');
  }, { timeoutMs: 5_000, intervalMs: 50, message: 'disconnect UNKNOWN_OUTCOME' });
  const fenced = await observer.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'disconnect-retry-must-be-fenced' },
  });
  assert.equal(fenced.result?.structuredContent?.code, 'PROJECT_UNKNOWN_OUTCOME_FENCE');
  const cleanStatus = await observer.request('tools/call', {
    name: 'unity_router_status', arguments: {},
  });
  const cleanSnapshot = cleanStatus.result?.structuredContent;
  const cleanProject = cleanSnapshot?.projects?.find((entry) => entry.name === 'a');
  assert.equal(cleanSnapshot?.budget?.pendingTotal, 0);
  assert.equal(cleanSnapshot?.budget?.activeHeavy, 0);
  assert.equal(cleanSnapshot?.leases?.length, 0);
  assert.equal(cleanProject?.scheduler?.pending, 0);
  assert.equal(cleanProject?.scheduler?.activeOperationId, null);
  assert.equal(cleanProject?.child?.ready, true);
  await observer.request('tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: { operationId: unknown.operationId, resolution: 'abandoned' },
  });
  const events = await readEvents(harness.stateFile);
  const callIndex = events.findIndex((event) => event.kind === 'call-start' && event.marker === 'disconnect-cancel-mutation');
  const cancelIndex = events.findIndex((event) => event.kind === 'cancel' && event.reason === 'client disconnected');
  assert(callIndex >= 0 && cancelIndex > callIndex, JSON.stringify(events));
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'disconnect-cancel-mutation').length, 1);
  assert(events.filter((event) => event.kind === 'mutation' && event.marker === 'disconnect-cancel-mutation').length <= 1);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'disconnect-retry-must-be-fenced').length, 0);
});

test('adapter disconnect promptly quarantines an ignored safe read without retrying it', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness({ toolTimeoutSec: 300, deadlineSec: 300 });
  const victim = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  const observer = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await Promise.allSettled([victim.close(), observer.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([victim.initialize(), observer.initialize()]);
  await Promise.all([victim.request('tools/list'), observer.request('tools/list')]);

  const inFlight = victim.request('tools/call', {
    name: 'editor_status',
    arguments: { delayMs: 8_000, cancelMode: 'ignore', marker: 'disconnect-safe-read' },
  }, { id: 94, timeoutMs: 10_000 }).catch(() => null);
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'call-start' && event.marker === 'disconnect-safe-read'), {
    message: 'disconnect safe read dispatch',
  });

  const disconnectedAt = Date.now();
  await victim.close();
  const recovered = await observer.request('tools/call', {
    name: 'editor_status',
    arguments: { marker: 'safe-read-after-disconnect' },
  }, { timeoutMs: 10_000 });
  await inFlight;
  assert.equal(recovered.result?.isError, false);
  assert(Date.now() - disconnectedAt < 3_000, 'safe-read disconnect must promptly release the project lane');

  const status = await observer.request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(status.result?.structuredContent?.unknownOutcomes?.length, 0);
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'disconnect-safe-read').length, 1);
  assert.equal(events.filter((event) =>
    event.kind === 'call-start' && event.marker === 'safe-read-after-disconnect').length, 1);
});

test('cancel_tests shares the retained async leases and closes the test tracker', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');

  const started = await client.request('tools/call', {
    name: 'run_tests',
    arguments: { async_tests: true, delayMs: 5_000, marker: 'cancelable-tests' },
  });
  assert.equal(started.result?.structuredContent?.routerOperationState, 'RUNNING');
  const operationId = started.result?.structuredContent?.routerOperationId;

  const cancelled = await client.request('tools/call', {
    name: 'cancel_tests',
    arguments: {},
  });
  assert.equal(cancelled.result?.isError, false);
  await waitUntil(async () => {
    const operation = await client.request('tools/call', {
      name: 'unity_router_operation_status',
      arguments: { operationId },
    });
    return operation.result?.structuredContent?.state === 'COMPLETED';
  }, { timeoutMs: 5_000, intervalMs: 50, message: 'cancelled test tracker completion' });

  const status = await client.request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(status.result?.structuredContent?.projects?.[0]?.backgroundOperation, null);
  assert.equal(status.result?.structuredContent?.leases?.length, 0);
});

test('tracked async work retains global leases until its status becomes terminal', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');

  const started = await client.request('tools/call', {
    name: 'build',
    arguments: { confirm: true, delayMs: 650, marker: 'tracked-build' },
  });
  assert.equal(started.result?.structuredContent?.routerOperationState, 'RUNNING');
  const operationId = started.result?.structuredContent?.routerOperationId;
  assert.equal(typeof operationId, 'string');

  const fenced = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'blocked-during-build' },
  });
  assert.equal(fenced.result?.structuredContent?.code, 'PROJECT_ASYNC_OPERATION_FENCE');
  const statusDuring = await client.request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.deepEqual(
    new Set(statusDuring.result?.structuredContent?.leases?.map((lease) => lease.key)),
    new Set(['source-refresh', 'heavy', 'exclusive-editor']),
  );

  await waitUntil(async () => {
    const operation = await client.request('tools/call', {
      name: 'unity_router_operation_status',
      arguments: { operationId },
    });
    return operation.result?.structuredContent?.state === 'COMPLETED';
  }, { timeoutMs: 5_000, intervalMs: 100, message: 'tracked build completion' });

  const after = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'write-after-build' },
  });
  assert.equal(after.result?.isError, false);
  const statusAfter = await client.request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(statusAfter.result?.structuredContent?.leases?.length, 0);
});

test('an async trigger whose adapter disconnects becomes UNKNOWN_OUTCOME at terminal without replay', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness();
  const victim = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  const observer = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await Promise.allSettled([victim.close(), observer.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([victim.initialize(), observer.initialize()]);
  await Promise.all([victim.request('tools/list'), observer.request('tools/list')]);

  const startedPromise = victim.request('tools/call', {
    name: 'build',
    arguments: {
      confirm: true,
      delayMs: 600,
      responseDelayMs: 300,
      marker: 'disconnect-async-build',
    },
  }).catch(() => null);
  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'call-start' && event.marker === 'disconnect-async-build'), {
    message: 'async trigger dispatch before adapter disconnect',
  });
  await victim.close();
  await startedPromise;

  const operationId = await waitUntil(async () => {
    const status = await observer.request('tools/call', {
      name: 'unity_router_status', arguments: {},
    });
    return status.result?.structuredContent?.unknownOutcomes
      ?.find((operation) => operation.method === 'build')?.operationId;
  }, { timeoutMs: 5_000, intervalMs: 100, message: 'disconnected async operation fence' });
  const blocked = await observer.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'retry-after-disconnected-async' },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'PROJECT_UNKNOWN_OUTCOME_FENCE');
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'disconnect-async-build').length, 1);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'retry-after-disconnected-async').length, 0);
});

test('a mismatched buildId never completes or releases a recovered async fence', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');
  const started = await client.request('tools/call', {
    name: 'build', arguments: { confirm: true, delayMs: 1_800, marker: 'correlated-build' },
  });
  const operationId = started.result?.structuredContent?.routerOperationId;
  const buildId = started.result?.structuredContent?.buildId;
  assert.equal(typeof buildId, 'string');
  const asyncStatusFile = `${harness.stateFile}.${Buffer.from(harness.projectA).toString('hex').slice(-24)}.async.json`;
  await writeFile(asyncStatusFile, JSON.stringify({ status: 'completed', buildId: 'different-build' }));

  await waitUntil(async () => {
    const status = await client.request('tools/call', { name: 'unity_router_status', arguments: {} });
    return status.result?.structuredContent?.recoveryFaults?.some((fault) =>
      fault.operationId === operationId && fault.code === 'ASYNC_CORRELATION_MISMATCH');
  }, { timeoutMs: 4_000, intervalMs: 100, message: 'build correlation mismatch fence' });
  const operation = await client.request('tools/call', {
    name: 'unity_router_operation_status', arguments: { operationId },
  });
  assert.equal(operation.result?.structuredContent?.state, 'RUNNING');
  const blocked = await client.request('tools/call', {
    name: 'mutate_once', arguments: { marker: 'blocked-by-build-correlation' },
  });
  assert.equal(blocked.result?.structuredContent?.code, 'PROJECT_RECOVERY_FENCE');

  await waitUntil(async () => (await readEvents(harness.stateFile))
    .some((event) => event.kind === 'async-complete' && event.marker === 'correlated-build'), {
    timeoutMs: 5_000,
    message: 'original correlated build completion',
  });
  const terminal = await client.request('tools/call', { name: 'build_status', arguments: {} });
  assert.equal(terminal.result?.structuredContent?.buildId, buildId);
  const after = await client.request('tools/call', {
    name: 'mutate_once', arguments: { marker: 'after-correlated-build' },
  });
  assert.equal(after.result?.isError, false);
});

test('tracked async journal and leases recover after a broker crash without replay', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');
  const started = await client.request('tools/call', {
    name: 'build',
    arguments: { confirm: true, delayMs: 1_200, marker: 'recoverable-build' },
  });
  const operationId = started.result?.structuredContent?.routerOperationId;
  assert.equal(started.result?.structuredContent?.routerOperationState, 'RUNNING');
  client.notifications.length = 0;

  const oldPid = JSON.parse(await readFile(harness.pidPath, 'utf8')).pid;
  process.kill(oldPid, 'SIGKILL');
  await client.waitForNotification('notifications/tools/list_changed', 15_000);
  await waitUntil(async () => {
    try { return JSON.parse(await readFile(harness.pidPath, 'utf8')).pid !== oldPid; } catch { return false; }
  }, { timeoutMs: 15_000, message: 'replacement broker for tracked operation' });

  await waitUntil(async () => {
    const operation = await client.request('tools/call', {
      name: 'unity_router_operation_status',
      arguments: { operationId },
    });
    return operation.result?.structuredContent?.state === 'UNKNOWN_OUTCOME';
  }, { timeoutMs: 8_000, intervalMs: 150, message: 'recovered build terminal fence' });
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'recoverable-build').length, 1);
  const fenced = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'must-be-fenced-after-recovered-build' },
  });
  assert.equal(fenced.result?.structuredContent?.code, 'PROJECT_UNKNOWN_OUTCOME_FENCE');
  await client.request('tools/call', {
    name: 'unity_router_operation_resolve',
    arguments: { operationId, resolution: 'confirmed_completed' },
  });
  const after = await client.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'after-recovered-build' },
  });
  assert.equal(after.result?.isError, false);
});

test('a recovered async recompile keeps one reload generation through a late child notification', { timeout: 30_000 }, async (t) => {
  const harness = await createHarness({ notifyAfterTerminalStatusMs: 400 });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  await client.request('tools/list');
  const started = await client.request('tools/call', {
    name: 'recompile',
    arguments: { mode: 'async_success', delayMs: 1_200, marker: 'recoverable-recompile' },
  });
  const operationId = started.result?.structuredContent?.routerOperationId;
  assert.equal(started.result?.structuredContent?.routerOperationState, 'RUNNING');

  const oldPid = JSON.parse(await readFile(harness.pidPath, 'utf8')).pid;
  client.notifications.length = 0;
  process.kill(oldPid, 'SIGKILL');
  await client.waitForNotification('notifications/tools/list_changed', 15_000);
  await waitUntil(async () => {
    try { return JSON.parse(await readFile(harness.pidPath, 'utf8')).pid !== oldPid; } catch { return false; }
  }, { timeoutMs: 15_000, message: 'replacement broker for recovered recompile' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.notifications.length = 0;

  await client.waitForNotification('notifications/tools/list_changed', 12_000);
  await client.request('tools/list');
  const beforeLate = (await readEvents(harness.stateFile)).filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length;
  await waitUntil(async () => (await readEvents(harness.stateFile)).some((event) =>
    event.kind === 'tools-list-changed-notify' && event.phase === 'recovered-async-late'), {
    timeoutMs: 5_000,
    message: 'late recovered recompile child notification',
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(client.notifications.filter((message) =>
    message.method === 'notifications/tools/list_changed').length, 1);
  const afterLate = await readEvents(harness.stateFile);
  assert.equal(afterLate.filter((event) =>
    event.kind === 'tools-list' && event.projectPath === harness.projectA).length, beforeLate + 1);

  await waitUntil(async () => {
    const operation = await client.request('tools/call', {
      name: 'unity_router_operation_status', arguments: { operationId },
    });
    return operation.result?.structuredContent?.state === 'UNKNOWN_OUTCOME';
  }, { timeoutMs: 5_000, intervalMs: 100, message: 'recovered recompile terminal fence' });
});

test('workspace lease survives broker crash and only its exact adapter session may keep writing', { timeout: 30_000 }, async (t) => {
  const harness = await createHarness();
  const owner = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  const contender = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env });
  t.after(async () => {
    await Promise.allSettled([owner.close(), contender.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([owner.initialize(), contender.initialize()]);
  await Promise.all([owner.request('tools/list'), contender.request('tools/list')]);

  const begun = await owner.request('tools/call', {
    name: 'unity_router_workspace_begin',
    arguments: { project: 'a', ttlSec: 60 },
  });
  const leaseToken = begun.result?.structuredContent?.token;
  assert.equal(typeof leaseToken, 'string');
  owner.notifications.length = 0;
  contender.notifications.length = 0;

  const oldPid = JSON.parse(await readFile(harness.pidPath, 'utf8')).pid;
  process.kill(oldPid, 'SIGKILL');
  await Promise.all([
    owner.waitForNotification('notifications/tools/list_changed', 15_000),
    contender.waitForNotification('notifications/tools/list_changed', 15_000),
  ]);
  await waitUntil(async () => {
    try { return JSON.parse(await readFile(harness.pidPath, 'utf8')).pid !== oldPid; } catch { return false; }
  }, { timeoutMs: 15_000, message: 'replacement broker for workspace lease' });

  const heartbeat = await owner.request('tools/call', {
    name: 'unity_router_workspace_heartbeat',
    arguments: { leaseToken, ttlSec: 60 },
  });
  assert.equal(heartbeat.result?.structuredContent?.token, leaseToken);
  assert.equal(heartbeat.result?.structuredContent?.state, 'active');

  const blocked = await contender.request('tools/call', {
    name: 'mutate_once',
    arguments: { project: 'a', marker: 'workspace-contender-blocked' },
  });
  assert.equal(blocked.error?.code, -32000);
  assert.match(blocked.error?.message ?? '', /source-refresh/i);
  let events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'workspace-contender-blocked').length, 0);

  const ownerWrite = await owner.request('tools/call', {
    name: 'mutate_once',
    arguments: { marker: 'workspace-owner-write' },
  });
  assert.equal(ownerWrite.result?.isError, false);

  const ended = await owner.request('tools/call', {
    name: 'unity_router_workspace_end',
    arguments: { leaseToken },
  });
  assert.equal(ended.result?.structuredContent?.state, 'RELEASED');
  const afterRelease = await contender.request('tools/call', {
    name: 'mutate_once',
    arguments: { project: 'a', marker: 'workspace-contender-after-release' },
  });
  assert.equal(afterRelease.result?.isError, false);
  events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'workspace-owner-write').length, 1);
  assert.equal(events.filter((event) => event.kind === 'call-start' && event.marker === 'workspace-contender-after-release').length, 1);
});

test('known-broken Unity CLI versions are diagnosed before any MCP child starts', { timeout: 15_000 }, async (t) => {
  const harness = await createHarness({ cliVersion: '1.0.0-beta.2' });
  const client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  t.after(async () => {
    await client.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await client.initialize();
  const listed = await client.request('tools/list');
  assert(listed.result?.tools?.some((tool) => tool.name === 'unity_router_status'));
  assert(!listed.result?.tools?.some((tool) => tool.name === 'editor_status'));
  const blocked = await client.request('tools/call', { name: 'editor_status', arguments: {} });
  assert.equal(blocked.result?.structuredContent?.code, 'CLI_VERSION_UNSUPPORTED');
  const status = await client.request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(status.result?.structuredContent?.unity?.supported, false);
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'spawn').length, 0);
});

test('maintenance tools are hidden from ordinary agents and require an authenticated admin adapter', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness();
  const ordinary = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  const admin = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  t.after(async () => {
    await Promise.allSettled([ordinary.close(), admin.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([ordinary.initialize(), admin.initialize()]);
  const [ordinaryTools, adminTools] = await Promise.all([
    ordinary.request('tools/list'),
    admin.request('tools/list'),
  ]);
  assert(!ordinaryTools.result?.tools?.some((tool) => tool.name === 'unity_router_drain'));
  assert(!ordinaryTools.result?.tools?.some((tool) => tool.name === 'unity_router_operation_resolve'));
  assert(adminTools.result?.tools?.some((tool) => tool.name === 'unity_router_drain'));
  assert(adminTools.result?.tools?.some((tool) => tool.name === 'unity_router_operation_resolve'));

  const denied = await ordinary.request('tools/call', {
    name: 'unity_router_drain', arguments: { timeoutSec: 1 },
  });
  assert.equal(denied.result?.structuredContent?.code, 'ADMIN_REQUIRED');
  const workspace = await ordinary.request('tools/call', {
    name: 'unity_router_workspace_begin', arguments: { ttlSec: 60 },
  });
  const leaseToken = workspace.result?.structuredContent?.token;
  const [publicStatus, adminStatus] = await Promise.all([
    ordinary.request('tools/call', { name: 'unity_router_status', arguments: {} }),
    admin.request('tools/call', { name: 'unity_router_status', arguments: {} }),
  ]);
  assert(!JSON.stringify(publicStatus).includes(leaseToken));
  assert(JSON.stringify(adminStatus).includes(leaseToken));
  const drained = await admin.request('tools/call', {
    name: 'unity_router_drain', arguments: { timeoutSec: 1 },
  });
  assert.equal(drained.result?.structuredContent?.drained, false);
  const serializedDrain = JSON.stringify(drained);
  assert(!serializedDrain.includes(leaseToken));
  assert(!serializedDrain.includes('sessionNonce'));
  assert(!serializedDrain.includes('ownerId'));
  await ordinary.request('tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken },
  });
  const resumed = await admin.request('tools/call', { name: 'unity_router_resume', arguments: {} });
  assert.equal(resumed.result?.structuredContent?.draining, false);
});

test('a workspace fence cannot be released while its tracked async operation is running', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness();
  const owner = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env, admin: true });
  const contender = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'b', env: harness.env });
  t.after(async () => {
    await Promise.allSettled([owner.close(), contender.close()]);
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  await Promise.all([owner.initialize(), contender.initialize()]);
  await Promise.all([owner.request('tools/list'), contender.request('tools/list')]);
  const begun = await owner.request('tools/call', {
    name: 'unity_router_workspace_begin', arguments: { ttlSec: 60 },
  });
  const leaseToken = begun.result?.structuredContent?.token;
  const build = await owner.request('tools/call', {
    name: 'build', arguments: { confirm: true, delayMs: 650, marker: 'workspace-build' },
  });
  const operationId = build.result?.structuredContent?.routerOperationId;
  const prematureEnd = await owner.request('tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken },
  });
  assert.equal(prematureEnd.result?.structuredContent?.code, 'WORKSPACE_ASYNC_ACTIVE');
  const forcedWorkspaceResolve = await owner.request('tools/call', {
    name: 'unity_router_workspace_resolve', arguments: { leaseToken, confirm: true },
  });
  assert.equal(forcedWorkspaceResolve.result?.structuredContent?.code, 'WORKSPACE_ASYNC_ACTIVE');
  const unsafeRetry = await owner.request('tools/call', {
    name: 'unity_router_operation_resolve', arguments: { operationId, resolution: 'safe_to_retry' },
  });
  assert.equal(unsafeRetry.result?.structuredContent?.code, 'RUNNING_RETRY_FORBIDDEN');
  const missingTerminalProof = await owner.request('tools/call', {
    name: 'unity_router_operation_resolve', arguments: { operationId, resolution: 'abandoned' },
  });
  assert.equal(missingTerminalProof.result?.structuredContent?.code, 'RUNNING_TERMINAL_CONFIRMATION_REQUIRED');
  const contenderWrite = await contender.request('tools/call', {
    name: 'mutate_once', arguments: { project: 'a', marker: 'blocked-by-workspace-async' },
  });
  assert(contenderWrite.error || contenderWrite.result?.isError);
  assert.equal((await readEvents(harness.stateFile))
    .filter((event) => event.kind === 'call-start' && event.marker === 'blocked-by-workspace-async').length, 0);

  await waitUntil(async () => {
    const status = await owner.request('tools/call', {
      name: 'unity_router_operation_status', arguments: { operationId },
    });
    return status.result?.structuredContent?.state === 'COMPLETED';
  }, { timeoutMs: 6_000, intervalMs: 100, message: 'workspace build terminal state' });
  const stillFenced = await contender.request('tools/call', {
    name: 'mutate_once', arguments: { project: 'a', marker: 'workspace-still-held-after-build' },
  });
  assert(stillFenced.error || stillFenced.result?.isError);
  assert.equal((await readEvents(harness.stateFile))
    .filter((event) => event.kind === 'call-start' && event.marker === 'workspace-still-held-after-build').length, 0);
  const ended = await owner.request('tools/call', {
    name: 'unity_router_workspace_end', arguments: { leaseToken },
  });
  assert.equal(ended.result?.structuredContent?.state, 'RELEASED');
  const after = await contender.request('tools/call', {
    name: 'mutate_once', arguments: { project: 'a', marker: 'after-workspace-build' },
  });
  assert.equal(after.result?.isError, false);
});

test('concurrent startup safely replaces one stale socket and still creates exactly one broker child', { timeout: 45_000 }, async (t) => {
  const harness = await createHarness();
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });

  const stale = spawn(process.execPath, ['-e', `
    const net = require('node:net');
    const server = net.createServer();
    server.listen(process.argv[1], () => process.stdout.write(String(process.pid) + '\\n'));
    setInterval(() => {}, 1000);
  `, path.join(harness.root, 'runtime', 'broker-v2.sock')], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitUntil(() => existsSync(path.join(harness.root, 'runtime', 'broker-v2.sock')), {
    timeoutMs: 5_000,
    message: 'stale socket fixture',
  });
  await writeFile(harness.pidPath, `${JSON.stringify({ pid: stale.pid })}\n`, { mode: 0o600 });
  stale.kill('SIGKILL');
  await new Promise((resolve) => stale.once('exit', resolve));
  assert.equal(existsSync(path.join(harness.root, 'runtime', 'broker-v2.sock')), true);

  for (let index = 0; index < 16; index += 1) {
    clients.push(new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env }));
  }
  await Promise.all(clients.map((client) => client.initialize()));
  await Promise.all(clients.map((client) => client.request('tools/list')));
  const status = await clients[0].request('tools/call', { name: 'unity_router_status', arguments: {} });
  assert.equal(status.result?.structuredContent?.broker?.clients, 16);
  const events = await readEvents(harness.stateFile);
  assert.equal(events.filter((event) => event.kind === 'spawn' && event.projectPath === harness.projectA).length, 1);
});

test('bootstrap corruption closes paused sockets promptly and a repaired store can restart', { timeout: 30_000 }, async (t) => {
  const harness = await createHarness();
  let heldSocket = null;
  let client = null;
  t.after(async () => {
    heldSocket?.destroy();
    await client?.close();
    await stopBroker(harness);
    await rm(harness.root, { recursive: true, force: true });
  });
  const workspaceFile = path.join(harness.root, 'workspace-leases.json');
  await writeFile(workspaceFile, `{"version":1,"leases":[${' '.repeat(5 * 1024 * 1024)}`, { mode: 0o600 });
  const broker = spawn(process.execPath, [BROKER, '--config', harness.configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: harness.env,
  });
  const exitPromise = new Promise((resolve) => broker.once('exit', (code, signal) => resolve({ code, signal })));
  heldSocket = await waitUntil(() => new Promise((resolve) => {
    const candidate = net.createConnection(path.join(harness.root, 'runtime', 'broker-v2.sock'));
    candidate.once('connect', () => resolve(candidate));
    candidate.once('error', () => { candidate.destroy(); resolve(null); });
  }), { timeoutMs: 5_000, intervalMs: 1, message: 'bootstrap socket connection' });
  const exited = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('corrupt bootstrap broker hung')), 5_000)),
  ]);
  assert.notEqual(exited.code, 0);
  await waitUntil(() => heldSocket.destroyed, { timeoutMs: 2_000, message: 'paused socket destruction' });

  await writeFile(workspaceFile, '{"version":1,"leases":[]}\n', { mode: 0o600 });
  client = new StdioMcpClient({ configPath: harness.configPath, defaultProject: 'a', env: harness.env });
  await client.initialize();
  const listed = await client.request('tools/list');
  assert(listed.result?.tools?.some((tool) => tool.name === 'editor_status'));
});
