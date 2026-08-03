#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage() {
  process.stderr.write(
    'usage: broker-admin.mjs <status|doctor|drain|resume> --runtime-root DIR --config FILE [--timeout-sec N]\n' +
    '       broker-admin.mjs operation status UUID --runtime-root DIR --config FILE\n' +
    '       broker-admin.mjs operation resolve UUID confirmed_completed [--confirm-no-longer-running] --runtime-root DIR --config FILE\n',
  );
  process.exit(64);
}

function parseRuntimeArgs(rest, { allowTimeout }) {
  if (rest.length !== 4 && !(allowTimeout && rest.length === 6)) usage();
  if (rest[0] !== '--runtime-root' || !rest[1] || rest[1].startsWith('--') ||
      rest[2] !== '--config' || !rest[3] || rest[3].startsWith('--')) usage();
  const values = { runtime_root: rest[1], config: rest[3], timeout_sec: 60 };
  if (rest.length === 6) {
    if (rest[4] !== '--timeout-sec' || !/^[0-9]+$/.test(rest[5])) usage();
    values.timeout_sec = Number(rest[5]);
    if (!Number.isSafeInteger(values.timeout_sec) || values.timeout_sec < 1 || values.timeout_sec > 600) usage();
  }
  return values;
}

function parseArgs(argv) {
  const command = argv[0];
  if (['status', 'doctor', 'drain', 'resume'].includes(command)) {
    return { command, ...parseRuntimeArgs(argv.slice(1), { allowTimeout: true }) };
  }
  if (command !== 'operation') usage();

  const operationAction = argv[1];
  const operationId = argv[2];
  if (!UUID.test(operationId ?? '')) usage();
  if (operationAction === 'status') {
    return {
      command,
      operation_action: operationAction,
      operation_id: operationId,
      ...parseRuntimeArgs(argv.slice(3), { allowTimeout: false }),
    };
  }
  if (operationAction !== 'resolve' || argv[3] !== 'confirmed_completed') usage();
  const confirmNoLongerRunning = argv[4] === '--confirm-no-longer-running';
  return {
    command,
    operation_action: operationAction,
    operation_id: operationId,
    resolution: 'confirmed_completed',
    confirm_no_longer_running: confirmNoLongerRunning,
    ...parseRuntimeArgs(argv.slice(confirmNoLongerRunning ? 5 : 4), { allowTimeout: false }),
  };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const runtimeRoot = path.resolve(args.runtime_root);
const configPath = path.resolve(args.config);
const configModule = await import(pathToFileURL(path.join(runtimeRoot, 'lib', 'config.mjs')).href);
const framingModule = await import(pathToFileURL(path.join(runtimeRoot, 'lib', 'mcp-framing.mjs')).href);
const buildModule = await import(pathToFileURL(path.join(runtimeRoot, 'lib', 'build-info.mjs')).href);
const adminModule = await import(pathToFileURL(path.join(runtimeRoot, 'lib', 'admin-token.mjs')).href);
const config = configModule.loadConfig({
  argv: ['--config', configPath, '--broker-mode', 'connect-only'],
  env: {},
  cwd: path.dirname(configPath),
  defaultConfigPath: configPath,
  allowPreparedProjects: true,
  requirePreparedProjects: process.env.UNITY_MCP_REQUIRE_PREPARED_CONFIG === '1',
});
const configHash = configModule.configFingerprint(config);
const decoder = new framingModule.JsonRpcLineDecoder();
const socket = net.createConnection(config.broker.socketPath);
const responses = new Map();
const deadline = Date.now() + args.timeout_sec * 1000;
let connected = false;
let terminalError = null;
let attachSettled = false;
let attachedResolve;
let attachedReject;
const attached = new Promise((resolve, reject) => { attachedResolve = resolve; attachedReject = reject; });
let nextId = 1;

function remainingMs() {
  return Math.max(1, deadline - Date.now());
}

function asTransportError(reason, code = 'BROKER_TRANSPORT_CLOSED') {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  if (!error.code) error.code = code;
  return error;
}

function rejectAttached(error) {
  if (attachSettled) return;
  attachSettled = true;
  attachedReject(error);
}

function resolveAttached(value) {
  if (attachSettled) return;
  attachSettled = true;
  attachedResolve(value);
}

function failTransport(reason) {
  const error = asTransportError(reason);
  terminalError ??= error;
  rejectAttached(error);
  for (const [id, pending] of responses) {
    responses.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function send(message) {
  if (socket.destroyed || terminalError) throw terminalError ?? new Error('broker socket is closed');
  socket.write(framingModule.encodeJsonRpcLine(message));
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      responses.delete(id);
      const error = Object.assign(new Error(`${method} timed out`), { code: 'BROKER_REQUEST_TIMEOUT' });
      reject(error);
      socket.destroy(error);
    }, remainingMs());
    responses.set(id, { resolve, reject, timer });
    try { send({ jsonrpc: '2.0', id, method, params }); }
    catch (error) {
      clearTimeout(timer);
      responses.delete(id);
      reject(error);
    }
  });
}

socket.on('connect', async () => {
  try {
    const adminToken = await adminModule.readAdminToken(config.broker.adminTokenFile);
    send({
      type: 'attach',
      protocol: 1,
      configHash,
      clientId: `installer-${process.pid}`,
      sessionNonce: `installer-${process.pid}-${Date.now()}`,
      clientKind: 'installer',
      adapterVersion: buildModule.BUILD_INFO.version,
      adapterBuildId: buildModule.BUILD_INFO.buildId,
      adapterPid: process.pid,
      defaultProject: config.defaultProject,
      adminToken,
    });
  } catch (error) {
    rejectAttached(error);
    socket.destroy(error);
  }
});
socket.on('data', (chunk) => {
  let messages;
  try {
    messages = decoder.push(chunk);
  } catch (error) {
    failTransport(error);
    socket.destroy(error);
    return;
  }
  for (const message of messages) {
    if (message?.type === 'attached') resolveAttached(message);
    else if (message?.type === 'attach_error') rejectAttached(new Error(message.message));
    else if (responses.has(message?.id)) {
      const pending = responses.get(message.id);
      responses.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }
});
socket.on('end', () => failTransport(new Error('broker socket ended')));
socket.on('close', () => failTransport(new Error('broker socket closed')));
socket.on('error', (error) => failTransport(error));

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('broker connection timed out'), { code: 'BROKER_CONNECT_TIMEOUT' });
      reject(error);
      socket.destroy(error);
    }, remainingMs());
    socket.once('connect', () => {
      clearTimeout(timer);
      connected = true;
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
} catch (error) {
  const offline = ['ENOENT', 'ECONNREFUSED'].includes(error?.code);
  let livePid = null;
  try {
    const pid = JSON.parse(readFileSync(path.join(path.dirname(config.broker.socketPath), 'broker-v2.pid'), 'utf8')).pid;
    process.kill(pid, 0);
    livePid = pid;
  } catch (pidError) {
    if (pidError?.code === 'EPERM') livePid = 'owned-by-another-user';
  }
  write({ ok: false, offline: offline && livePid == null, livePid, code: error?.code, message: error.message });
  socket.destroy();
  process.exit(offline && livePid == null ? 20 : 21);
}

try {
  const attachTimer = setTimeout(() => {
    const error = Object.assign(new Error('broker attach timed out'), { code: 'BROKER_ATTACH_TIMEOUT' });
    rejectAttached(error);
    socket.destroy(error);
  }, remainingMs());
  try { await attached; } finally { clearTimeout(attachTimer); }
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'unity-mcp-router-installer', version: '1' },
  });
  if (initialized.error) throw new Error(initialized.error.message);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  let tool;
  let toolArguments;
  if (args.command === 'operation' && args.operation_action === 'status') {
    tool = 'unity_router_operation_status';
    toolArguments = { operationId: args.operation_id };
  } else if (args.command === 'operation' && args.operation_action === 'resolve') {
    tool = 'unity_router_operation_resolve';
    toolArguments = {
      operationId: args.operation_id,
      resolution: args.resolution,
      ...(args.confirm_no_longer_running ? { confirmNoLongerRunning: true } : {}),
    };
  } else {
    tool = {
      status: 'unity_router_status',
      doctor: 'unity_router_doctor',
      drain: 'unity_router_drain',
      resume: 'unity_router_resume',
    }[args.command];
    toolArguments = args.command === 'drain' ? { timeoutSec: args.timeout_sec } : {};
  }
  const response = await request('tools/call', {
    name: tool,
    arguments: toolArguments,
  });
  if (response.error) throw new Error(response.error.message);
  const structured = response.result?.structuredContent ?? {};
  const ok = !response.result?.isError && (args.command !== 'drain' || structured.drained === true);
  write({
    ok,
    command: args.command,
    ...(args.operation_action ? { action: args.operation_action } : {}),
    result: structured,
  });
  process.exitCode = ok ? 0 : 3;
} catch (error) {
  write({ ok: false, connected, message: error.message });
  process.exitCode = 21;
} finally {
  failTransport(new Error('broker admin completed'));
  socket.destroy();
}
