import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BROKER = path.join(ROOT, 'broker-daemon.mjs');
const ADMIN = path.join(ROOT, 'scripts', 'broker-admin.mjs');
const FAKE_UNITY = path.join(ROOT, 'test', 'fixtures', 'fake-unity.mjs');
const OPERATION_ID = '123e4567-e89b-12d3-a456-426614174000';

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for broker fixture');
}

function runAdmin(args, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [ADMIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`admin process exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function transportFixture(t, onConnection) {
  const root = mkdtempSync('/tmp/uadmin-transport-');
  const project = path.join(root, 'Project');
  const runtime = path.join(root, 'run');
  mkdirSync(path.join(project, 'Assets'), { recursive: true });
  mkdirSync(path.join(project, 'ProjectSettings'));
  mkdirSync(runtime);
  const config = path.join(root, 'config.json');
  const socketPath = path.join(runtime, 'broker.sock');
  const token = path.join(runtime, 'admin-token');
  writeFileSync(token, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 2,
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    minimumCliVersion: '1.0.0-beta.3',
    defaultProject: 'fixture',
    projects: [{ name: 'fixture', path: project }],
    reauthIntervalMin: 0,
    license: { mode: 'floating', maxConcurrentEditors: 2 },
    broker: {
      socketPath,
      journalFile: path.join(runtime, 'operations.jsonl'),
      workspaceLeaseFile: path.join(runtime, 'workspace.json'),
      adminTokenFile: token,
      processAuditEnforcement: 'report-only',
    },
    logFile: path.join(runtime, 'broker.log'),
  }, null, 2)}\n`);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { config };
}

async function toolCaptureFixture(t) {
  const attaches = [];
  const calls = [];
  const fixture = await transportFixture(t, (socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.type === 'attach') {
          attaches.push(message);
          socket.write(`${JSON.stringify({ type: 'attached' })}\n`);
        } else if (message.method === 'initialize') {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
        } else if (message.method === 'tools/call') {
          calls.push(message.params);
          socket.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { structuredContent: { forwarded: message.params } },
          })}\n`);
        }
      }
    });
  });
  return { ...fixture, attaches, calls };
}

test('broker-admin authenticates status, doctor, drain, and resume with the private capability token', async (t) => {
  const root = mkdtempSync('/tmp/uadmin-');
  const project = path.join(root, 'Project');
  const runtime = path.join(root, 'run');
  mkdirSync(path.join(project, 'Assets'), { recursive: true });
  mkdirSync(path.join(project, 'ProjectSettings'));
  mkdirSync(runtime);
  chmodSync(FAKE_UNITY, 0o755);
  const config = path.join(root, 'config.json');
  const socket = path.join(runtime, 'broker.sock');
  const token = path.join(root, 'admin-token');
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 2,
    unityBin: process.execPath,
    unityArgs: [FAKE_UNITY],
    minimumCliVersion: '1.0.0-beta.3',
    defaultProject: 'fixture',
    projects: [{ name: 'fixture', path: project }],
    reauthIntervalMin: 0,
    license: { mode: 'floating', maxConcurrentEditors: 2 },
    broker: {
      socketPath: socket,
      journalFile: path.join(root, 'operations.jsonl'),
      workspaceLeaseFile: path.join(root, 'workspace.json'),
      adminTokenFile: token,
      processAuditEnforcement: 'report-only',
      childIdleMin: 1,
    },
    logFile: path.join(root, 'broker.log'),
  }, null, 2)}\n`);

  const broker = spawn(process.execPath, [BROKER, '--config', config], {
    env: { ...process.env, FAKE_UNITY_VERSION: '1.0.0-beta.3' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let brokerError = '';
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', (chunk) => { brokerError += chunk; });
  t.after(async () => {
    if (broker.exitCode == null) broker.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => broker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => (existsSync(socket) && existsSync(token)) || broker.exitCode != null);
  assert.equal(broker.exitCode, null, brokerError);
  assert.match(readFileSync(token, 'utf8').trim(), /^[a-f0-9]{64}$/);

  for (const command of ['status', 'doctor', 'drain', 'resume']) {
    const result = spawnSync(process.execPath, [
      ADMIN,
      command,
      '--runtime-root', ROOT,
      '--config', config,
      '--timeout-sec', '5',
    ], { encoding: 'utf8', timeout: 15_000 });
    if (command === 'doctor') {
      assert([0, 3].includes(result.status), `${command}: ${result.stderr}\n${result.stdout}`);
    } else {
      assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
    }
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.command, command);
    if (command === 'doctor') {
      assert.equal(payload.result.projectAccess.ok, true);
      assert.equal(payload.result.responsibleExecutable, process.execPath);
    } else {
      assert.equal(payload.ok, true);
    }
    if (command === 'drain') assert.equal(payload.result.drained, true);
  }
});

test('broker-admin forwards only the bounded operation status and confirmed-completed resolution shapes', async (t) => {
  const { config, attaches, calls } = await toolCaptureFixture(t);
  const cases = [
    {
      argv: ['operation', 'status', OPERATION_ID],
      expected: {
        name: 'unity_router_operation_status',
        arguments: { operationId: OPERATION_ID },
      },
      action: 'status',
    },
    {
      argv: ['operation', 'resolve', OPERATION_ID, 'confirmed_completed'],
      expected: {
        name: 'unity_router_operation_resolve',
        arguments: { operationId: OPERATION_ID, resolution: 'confirmed_completed' },
      },
      action: 'resolve',
    },
    {
      argv: [
        'operation', 'resolve', OPERATION_ID, 'confirmed_completed',
        '--confirm-no-longer-running',
      ],
      expected: {
        name: 'unity_router_operation_resolve',
        arguments: {
          operationId: OPERATION_ID,
          resolution: 'confirmed_completed',
          confirmNoLongerRunning: true,
        },
      },
      action: 'resolve',
    },
  ];

  for (const entry of cases) {
    const result = await runAdmin([
      ...entry.argv, '--runtime-root', ROOT, '--config', config,
    ]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.command, 'operation');
    assert.equal(payload.action, entry.action);
  }

  assert.deepEqual(calls, cases.map((entry) => entry.expected));
  assert.equal(attaches.length, cases.length);
  for (const attach of attaches) {
    assert.equal(attach.adminToken, 'a'.repeat(64));
    assert.equal(attach.clientKind, 'installer');
  }
});

test('broker-admin rejects malformed UUIDs, broader resolutions, pass-through, and reordered operation argv', () => {
  const internal = ['--runtime-root', ROOT, '--config', '/not/read/for/rejected-argv.json'];
  const rejected = [
    [],
    ['call', 'unity_router_operation_status', '{}', ...internal],
    ['restart', 'fixture', ...internal],
    ['workspace', 'resolve', 'lease-token', '--confirm', ...internal],
    ['operation', ...internal],
    ['operation', 'status', 'op-1', ...internal],
    ['operation', 'status', '123e4567-e89b-12d3-a456-42661417400g', ...internal],
    ['operation', 'status', '123e4567e89b12d3a456426614174000', ...internal],
    ['operation', 'status', OPERATION_ID, '--confirm-no-longer-running', ...internal],
    ['operation', 'status', OPERATION_ID, ...internal, '--timeout-sec', '5'],
    ['operation', 'resolve', OPERATION_ID, 'safe_to_retry', ...internal],
    ['operation', 'resolve', OPERATION_ID, 'abandoned', ...internal],
    ['operation', 'resolve', OPERATION_ID, '--confirm-no-longer-running', 'confirmed_completed', ...internal],
    ['operation', 'resolve', OPERATION_ID, 'confirmed_completed', '--confirm-no-longer-running', '--confirm-no-longer-running', ...internal],
    ['operation', 'resolve', OPERATION_ID, 'confirmed_completed', '--config', '/tmp/config', '--runtime-root', ROOT],
    ['operation', 'resolve', `${OPERATION_ID}0`, 'confirmed_completed', ...internal],
  ];

  for (const argv of rejected) {
    const result = spawnSync(process.execPath, [ADMIN, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 64, `${argv.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /^usage:/);
  }
});

test('broker-admin bounds a blackholed attach with the global timeout and exit 21', async (t) => {
  const { config } = await transportFixture(t, (socket) => socket.resume());
  const result = await runAdmin([
    'status', '--runtime-root', ROOT, '--config', config, '--timeout-sec', '1',
  ]);
  assert.equal(result.status, 21, `${result.stderr}\n${result.stdout}`);
  assert(result.elapsedMs < 3_000, `blackhole took ${result.elapsedMs}ms`);
  assert.match(result.stdout, /attach timed out/);
});

test('broker-admin rejects an immediate transport close without hanging', async (t) => {
  const { config } = await transportFixture(t, (socket) => socket.destroy());
  const result = await runAdmin([
    'status', '--runtime-root', ROOT, '--config', config, '--timeout-sec', '1',
  ]);
  assert.equal(result.status, 21, `${result.stderr}\n${result.stdout}`);
  assert(result.elapsedMs < 3_000, `immediate close took ${result.elapsedMs}ms`);
  assert.match(result.stdout, /socket (closed|ended)/);
});

test('broker-admin applies the same deadline to a pending initialize request', async (t) => {
  const { config } = await transportFixture(t, (socket) => {
    let buffer = '';
    let messages = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        buffer = buffer.slice(newline + 1);
        messages += 1;
        if (messages === 1) socket.write(`${JSON.stringify({ type: 'attached' })}\n`);
        // Deliberately ignore initialize after a successful attach.
      }
    });
  });
  const result = await runAdmin([
    'status', '--runtime-root', ROOT, '--config', config, '--timeout-sec', '1',
  ]);
  assert.equal(result.status, 21, `${result.stderr}\n${result.stdout}`);
  assert(result.elapsedMs < 3_000, `pending request took ${result.elapsedMs}ms`);
  assert.match(result.stdout, /initialize timed out/);
});

test('broker-admin rejects end while an initialized request is pending', async (t) => {
  const { config } = await transportFixture(t, (socket) => {
    let buffer = '';
    let messages = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        buffer = buffer.slice(newline + 1);
        messages += 1;
        if (messages === 1) socket.write(`${JSON.stringify({ type: 'attached' })}\n`);
        else if (messages === 2) socket.end();
      }
    });
  });
  const result = await runAdmin([
    'status', '--runtime-root', ROOT, '--config', config, '--timeout-sec', '2',
  ]);
  assert.equal(result.status, 21, `${result.stderr}\n${result.stdout}`);
  assert(result.elapsedMs < 3_000, `pending close took ${result.elapsedMs}ms`);
  assert.match(result.stdout, /socket (closed|ended)/);
});
