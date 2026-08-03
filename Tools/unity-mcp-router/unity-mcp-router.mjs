#!/usr/bin/env node
/**
 * Backward-compatible stdio adapter for the machine-wide Unity MCP broker.
 *
 * Every Codex/Claude process still launches this small adapter, but only the
 * broker owns official `unity mcp` child processes. Closing this adapter never
 * stops another client or a shared Unity child.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { configFingerprint, loadConfig } from './lib/config.mjs';
import { loadOrCreateAdminToken } from './lib/admin-token.mjs';
import { BUILD_INFO } from './lib/build-info.mjs';
import { classifyFailure, FAILURE_CLASSIFICATION_SAMPLES } from './lib/failure-classifier.mjs';
import { JsonRpcLineDecoder, encodeJsonRpcLine } from './lib/mcp-framing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_VERSION = BUILD_INFO.version;
const ATTACH_PROTOCOL = 1;
const MAX_BUFFERED_WHILE_RECONNECTING = 32;

function diagnostic(message) {
  process.stderr.write(`unity-mcp-router: ${message}\n`);
}

function selfCheck() {
  let failed = 0;
  for (const [message, expected] of FAILURE_CLASSIFICATION_SAMPLES) {
    const actual = classifyFailure({ result: { isError: true, content: [{ type: 'text', text: message }] } });
    if (actual !== expected) {
      failed += 1;
      process.stdout.write(`FAIL want=${expected} got=${actual}: ${message}\n`);
    }
  }
  process.stdout.write(failed ? `\n${failed} failed\n` : `classifyFailure: ${FAILURE_CLASSIFICATION_SAMPLES.length} ok\n`);
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--self-check')) selfCheck();

const config = loadConfig({
  cwd: HERE,
  allowPreparedProjects: true,
  requirePreparedProjects: process.env.UNITY_MCP_REQUIRE_PREPARED_CONFIG === '1',
});
const hash = configFingerprint(config);
const socketPath = config.broker.socketPath;
const clientId = randomUUID();
const sessionNonce = randomUUID();
const brokerMode = config.brokerMode;
const adminMode = process.argv.includes('--admin');
const adminToken = adminMode ? await loadOrCreateAdminToken(config.broker.adminTokenFile) : null;

let socket = null;
let socketDecoder = null;
let attached = false;
let ready = false;
let reconnecting = false;
let shuttingDown = false;
let initialized = false;
let initializeMessage = null;
let initializedNotification = null;
let reconnectInitializeId = null;
let reconnectAttempt = 0;
let attachTimer = null;
let forceCloseTimer = null;
let deliveryFlushes = 0;
const connectingSockets = new Set();
const pending = new Map();
const bufferedOutbound = [];

function clientRequestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function writeClient(message) {
  let frame;
  try { frame = encodeJsonRpcLine(message); }
  catch (error) {
    diagnostic(`stdout framing failed: ${error.message}`);
    shutdown(1);
    return;
  }
  const metadata = message?.result?.structuredContent;
  const requiresDeliveryAck = metadata?.routerDeliveryAckRequired === true &&
    typeof metadata.routerOperationId === 'string';
  if (requiresDeliveryAck) {
    deliveryFlushes += 1;
    process.stdin.pause();
  }
  const finishDeliveryFlush = () => {
    if (!requiresDeliveryAck) return;
    deliveryFlushes = Math.max(0, deliveryFlushes - 1);
    if (deliveryFlushes === 0 && !shuttingDown) process.stdin.resume();
  };
  try {
    process.stdout.write(frame, (error) => {
      if (error) {
        finishDeliveryFlush();
        diagnostic(`stdout failed: ${error.message}`);
        shutdown(1);
        return;
      }
      if (
        requiresDeliveryAck &&
        socket && attached && ready && !socket.destroyed
      ) {
        socket.write(encodeJsonRpcLine({
          type: 'response_ack',
          protocol: ATTACH_PROTOCOL,
          requestId: message.id,
          operationId: metadata.routerOperationId,
        }));
      }
      // ACK and later client requests share the same broker socket. Resume
      // stdin only after enqueueing the ACK so a sequential next mutation can
      // never overtake completion of the prior delivery handshake.
      finishDeliveryFlush();
    });
  } catch (error) {
    finishDeliveryFlush();
    diagnostic(`stdout failed: ${error.message}`);
    shutdown(1);
  }
}

function brokerArgs() {
  const adapterArgs = process.argv.slice(2);
  const result = [path.join(HERE, 'broker-daemon.mjs')];
  const adapterOnlyWithValue = new Set(['--default', '--broker-mode']);
  for (let index = 0; index < adapterArgs.length; index += 1) {
    const flag = adapterArgs[index];
    if (flag === '--self-check') continue;
    if (flag === '--admin') continue;
    if (adapterOnlyWithValue.has(flag)) {
      index += 1;
      continue;
    }
    result.push(flag);
    if (flag.startsWith('--') && index + 1 < adapterArgs.length && !adapterArgs[index + 1].startsWith('--')) {
      result.push(adapterArgs[++index]);
    }
  }
  // The adjacent default path is implicit for both processes. An explicit
  // path is retained above so a machine-local config remains the SSoT.
  return result;
}

function startBroker() {
  if (brokerMode === 'connect-only') return;
  const proc = spawn(process.execPath, brokerArgs(), {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  proc.unref();
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const candidate = net.createConnection(socketPath);
    connectingSockets.add(candidate);
    const finish = () => connectingSockets.delete(candidate);
    const timer = setTimeout(() => {
      finish();
      candidate.destroy();
      reject(Object.assign(new Error(`Timed out connecting to broker at ${socketPath}`), { code: 'ETIMEDOUT' }));
    }, 1_000);
    candidate.once('connect', () => {
      clearTimeout(timer);
      finish();
      resolve(candidate);
    });
    candidate.once('error', (error) => {
      clearTimeout(timer);
      finish();
      reject(error);
    });
  });
}

async function connectBroker({ allowStart = true, forever = false } = {}) {
  let lastStartAt = 0;
  const deadline = forever ? Number.POSITIVE_INFINITY : Date.now() + config.startupTimeoutSec * 1000;
  for (;;) {
    if (shuttingDown) throw Object.assign(new Error('Adapter is shutting down.'), { code: 'ESHUTDOWN' });
    try {
      const candidate = await openSocket();
      bindSocket(candidate);
      sendAttach();
      return;
    } catch (error) {
      if (shuttingDown) throw Object.assign(new Error('Adapter is shutting down.'), { code: 'ESHUTDOWN' });
      const unavailable = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
      if (!unavailable) throw error;
      if (allowStart && brokerMode !== 'connect-only' && Date.now() - lastStartAt >= 2_000) {
        startBroker();
        lastStartAt = Date.now();
      }
      if (Date.now() >= deadline) throw new Error(`Broker did not become ready at ${socketPath}: ${error.message}`);
      const backoff = Math.min(750, 50 * 2 ** Math.min(reconnectAttempt, 4)) + Math.floor(Math.random() * 50);
      reconnectAttempt += 1;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

function bindSocket(candidate) {
  if (attachTimer) clearTimeout(attachTimer);
  socket = candidate;
  socketDecoder = new JsonRpcLineDecoder();
  attached = false;
  ready = false;
  attachTimer = setTimeout(() => {
    if (socket !== candidate || attached || candidate.destroyed) return;
    diagnostic(`Broker attach handshake timed out at ${socketPath}.`);
    candidate.destroy();
  }, Math.min(5_000, Math.max(1_000, config.startupTimeoutSec * 1_000)));
  candidate.on('data', (chunk) => {
    let messages;
    try { messages = socketDecoder.push(chunk); }
    catch (error) {
      diagnostic(`broker framing rejected: ${error.message}`);
      candidate.destroy();
      return;
    }
    for (const message of messages) onBrokerMessage(message);
  });
  candidate.on('error', (error) => diagnostic(`broker socket: ${error.message}`));
  candidate.on('close', () => onBrokerClosed(candidate));
}

function sendAttach() {
  socket.write(encodeJsonRpcLine({
    type: 'attach',
    protocol: ATTACH_PROTOCOL,
    clientId,
    sessionNonce,
    clientKind: adminMode ? 'admin-cli' : 'stdio-adapter',
    adapterVersion: ADAPTER_VERSION,
    adapterBuildId: BUILD_INFO.buildId,
    adapterPid: process.pid,
    configHash: hash,
    defaultProject: config.defaultProject,
    ...(adminToken == null ? {} : { adminToken }),
  }));
}

function sendBroker(message) {
  if (!ready || !socket || socket.destroyed) {
    if (bufferedOutbound.length >= MAX_BUFFERED_WHILE_RECONNECTING) {
      if (message.id != null) {
        writeClient({ jsonrpc: '2.0', id: message.id, error: { code: -32082, message: 'Broker reconnect queue is full.' } });
      }
      return;
    }
    bufferedOutbound.push(message);
    return;
  }
  trackPending(message);
  socket.write(encodeJsonRpcLine(message));
}

function trackPending(message) {
  if (message.id == null || message.id === reconnectInitializeId) return;
  pending.set(clientRequestKey(message.id), { id: message.id, method: message.method, sentAt: Date.now() });
}

function flushBuffered() {
  while (ready && bufferedOutbound.length) {
    const message = bufferedOutbound.shift();
    trackPending(message);
    socket.write(encodeJsonRpcLine(message));
  }
}

function onBrokerMessage(message) {
  if (!attached) {
    if (message?.type === 'attach_error') {
      diagnostic(`${message.code}: ${message.message}`);
      shuttingDown = true;
      socket.end();
      process.stdin.pause();
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
      return;
    }
    if (message?.type !== 'attached') {
      diagnostic('Broker did not acknowledge attach protocol.');
      socket.destroy();
      return;
    }
    attached = true;
    if (attachTimer) clearTimeout(attachTimer);
    attachTimer = null;
    reconnectAttempt = 0;
    if (initialized && initializeMessage) {
      reconnectInitializeId = `adapter-reconnect:${randomUUID()}`;
      socket.write(encodeJsonRpcLine({ ...initializeMessage, id: reconnectInitializeId }));
    } else {
      ready = true;
      flushBuffered();
    }
    return;
  }

  if (reconnectInitializeId != null && message.id === reconnectInitializeId) {
    reconnectInitializeId = null;
    if (message.error) {
      diagnostic(`Broker reinitialize failed: ${message.error.message}`);
      socket.destroy();
      return;
    }
    if (initializedNotification) socket.write(encodeJsonRpcLine(initializedNotification));
    ready = true;
    flushBuffered();
    // The user-authored listChanged=true behavior remains essential: after a
    // broker or Editor reconnect, clients must rediscover the live tool list.
    writeClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    return;
  }

  if (message.id != null) pending.delete(clientRequestKey(message.id));
  writeClient(message);
}

function onBrokerClosed(closedSocket) {
  if (socket !== closedSocket) return;
  if (attachTimer) clearTimeout(attachTimer);
  attachTimer = null;
  socket = null;
  attached = false;
  ready = false;
  reconnectInitializeId = null;
  if (shuttingDown) {
    if (forceCloseTimer) clearTimeout(forceCloseTimer);
    forceCloseTimer = null;
    return;
  }

  for (const entry of pending.values()) {
    writeClient({
      jsonrpc: '2.0',
      id: entry.id,
      error: {
        code: -32074,
        message:
          `Shared Unity broker disconnected while ${entry.method} was in flight. ` +
          'The request was not replayed; a mutation may have UNKNOWN_OUTCOME.',
      },
    });
  }
  pending.clear();
  reconnect().catch((error) => {
    diagnostic(`reconnect failed: ${error.message}`);
    process.exitCode = 1;
  });
}

async function reconnect() {
  if (reconnecting || shuttingDown) return;
  reconnecting = true;
  try {
    while (!shuttingDown) {
      try {
        await connectBroker({ allowStart: true, forever: true });
        return;
      } catch (error) {
        if (shuttingDown || error?.code === 'ESHUTDOWN') return;
        diagnostic(`reconnect attempt failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  } finally { reconnecting = false; }
}

await connectBroker({ allowStart: true });

const stdinDecoder = new JsonRpcLineDecoder();
process.stdin.on('data', (chunk) => {
  let messages;
  try { messages = stdinDecoder.push(chunk); }
  catch (error) {
    diagnostic(`client framing rejected: ${error.message}`);
    return;
  }
  for (const message of messages) {
    if (message.method === 'initialize' && message.id != null) initializeMessage = structuredClone(message);
    if (message.method === 'notifications/initialized') {
      initialized = true;
      initializedNotification = structuredClone(message);
    }
    sendBroker(message);
  }
});
process.stdin.on('end', () => shutdown(0));
process.stdin.resume();
process.stdout.on('error', (error) => {
  diagnostic(`stdout stream failed: ${error.message}`);
  shutdown(1);
});

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  process.stdin.pause();
  if (attachTimer) clearTimeout(attachTimer);
  attachTimer = null;
  for (const candidate of connectingSockets) {
    candidate.destroy(Object.assign(new Error('Adapter is shutting down.'), { code: 'ESHUTDOWN' }));
  }
  connectingSockets.clear();
  const closingSocket = socket;
  try { closingSocket?.end(); } catch { closingSocket?.destroy(); }
  if (closingSocket && !closingSocket.destroyed) {
    forceCloseTimer = setTimeout(() => {
      forceCloseTimer = null;
      closingSocket.destroy();
    }, 1_000);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  diagnostic(`uncaught exception: ${error.stack ?? error.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  diagnostic(`unhandled rejection: ${error?.stack ?? error}`);
  shutdown(1);
});
