#!/usr/bin/env node
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BrokerCore, SERVER_VERSION } from './lib/broker-core.mjs';
import { loadOrCreateAdminToken, verifyAdminToken } from './lib/admin-token.mjs';
import { BUILD_INFO } from './lib/build-info.mjs';
import { configFingerprint, loadConfig } from './lib/config.mjs';
import { StructuredLogger } from './lib/logger.mjs';
import { JsonRpcLineDecoder, encodeJsonRpcLine } from './lib/mcp-framing.mjs';
import { OperationJournal } from './lib/operation-journal.mjs';
import { WorkspaceLeaseStore } from './lib/workspace-lease-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function diagnostic(message) {
  process.stderr.write(`unity-mcp-broker: ${message}\n`);
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function pidIsBroker(pid) {
  if (!pidIsAlive(pid)) return false;
  try {
    return /(?:^|\s|\/)broker-daemon\.mjs(?:\s|$)/.test(
      execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 2_000,
        killSignal: 'SIGKILL',
      }),
    );
  } catch { return false; }
}

function acquireStartupLock(lockPath) {
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return { lockPath, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); } catch { /* stale/incomplete */ }
      if (pidIsBroker(owner?.pid)) throw new Error(`Broker startup already owned by pid ${owner.pid}`);
      if (!owner) {
        const ageMs = Date.now() - lstatSync(lockPath).mtimeMs;
        if (ageMs < 5_000) throw new Error('Broker startup lock is still being initialized');
      }
      const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      try { renameSync(lockPath, quarantine); }
      catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      rmSync(quarantine, { recursive: true, force: true });
    }
  }
}

function releaseStartupLock(lock) {
  if (!lock) return;
  try {
    const owner = JSON.parse(readFileSync(path.join(lock.lockPath, 'owner.json'), 'utf8'));
    if (owner.token === lock.token) rmSync(lock.lockPath, { recursive: true, force: true });
  } catch { /* never remove a lock whose ownership cannot be proven */ }
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new Error(`Timed out probing existing broker socket: ${socketPath}`));
    }, 500);
    probe.once('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once('error', (error) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

async function removeOwnedStaleSocket(socketPath, pidPath) {
  if (!existsSync(socketPath)) return;
  const stat = lstatSync(socketPath);
  const currentUid = process.getuid?.();
  if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
  if (currentUid != null && stat.uid !== currentUid) throw new Error(`Refusing to replace socket owned by uid ${stat.uid}`);
  let priorPid = null;
  try { priorPid = JSON.parse(readFileSync(pidPath, 'utf8')).pid; } catch { /* missing/corrupt is not proof of a live owner */ }
  if (pidIsBroker(priorPid) || await socketAcceptsConnections(socketPath)) {
    throw new Error(`Broker already appears live${priorPid ? ` with pid ${priorPid}` : ''}`);
  }
  unlinkSync(socketPath);
  if (existsSync(pidPath)) unlinkSync(pidPath);
}

const config = loadConfig({
  cwd: HERE,
  allowPreparedProjects: true,
  requirePreparedProjects: process.env.UNITY_MCP_REQUIRE_PREPARED_CONFIG === '1',
});
const fingerprint = configFingerprint(config);
const socketPath = config.broker.socketPath;
const runtimeDir = path.dirname(socketPath);
const pidPath = path.join(runtimeDir, 'broker-v2.pid');
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
chmodSync(runtimeDir, 0o700);
const startupLock = acquireStartupLock(path.join(runtimeDir, 'broker-v2.starting'));
try { await removeOwnedStaleSocket(socketPath, pidPath); }
catch (error) {
  releaseStartupLock(startupLock);
  throw error;
}

const logger = new StructuredLogger(config.logFile, { context: { service: 'unity-mcp-broker' } });
// The durable journal must only be opened after this process wins the socket
// bind. Otherwise simultaneous adapter auto-starts can both replay and append
// recovery records before one loses EADDRINUSE.
let core = null;
let expectedAdminToken = null;
const bootstrapSockets = new Set();
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  if (!core) {
    bootstrapSockets.add(socket);
    socket.pause();
  }
  const decoder = new JsonRpcLineDecoder();
  let connection = null;
  let closed = false;

  const send = (message) => {
    if (!closed && !socket.destroyed) socket.write(encodeJsonRpcLine(message));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (connection) core?.detach(connection.id);
  };

  socket.on('data', (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      logger.warn('adapter framing rejected', { message: error.message, code: error.code });
      socket.destroy();
      return;
    }
    for (const message of messages) {
      if (!connection) {
        if (message?.type !== 'attach' || message?.protocol !== 1) {
          send({ type: 'attach_error', code: 'ATTACH_REQUIRED', message: 'First frame must be broker attach protocol 1.' });
          socket.end();
          return;
        }
        if (message.configHash !== fingerprint) {
          send({
            type: 'attach_error',
            code: 'CONFIG_MISMATCH',
            message: `Active broker config ${fingerprint}; adapter config ${message.configHash}. Drain/restart the broker instead of starting a second daemon.`,
          });
          socket.end();
          return;
        }
        if (message.adapterBuildId !== BUILD_INFO.buildId) {
          send({
            type: 'attach_error',
            code: 'ADAPTER_BUILD_MISMATCH',
            message: `Active broker build ${BUILD_INFO.buildId}; adapter build ${message.adapterBuildId ?? 'missing'}. ` +
              'Restart the client through the stable installed adapter wrapper.',
          });
          socket.end();
          return;
        }
        const requestedAdmin = message.adminToken != null;
        const isAdmin = requestedAdmin && verifyAdminToken(message.adminToken, expectedAdminToken);
        if (requestedAdmin && !isAdmin) {
          send({ type: 'attach_error', code: 'ADMIN_TOKEN_INVALID', message: 'Admin capability token is invalid.' });
          socket.end();
          return;
        }
        try {
          connection = core.attach({
            clientId: message.clientId,
            sessionNonce: message.sessionNonce,
            defaultProject: message.defaultProject,
            clientKind: message.clientKind,
            adapterVersion: message.adapterVersion,
            adapterBuildId: message.adapterBuildId,
            adapterPid: message.adapterPid,
            isAdmin,
            configHash: message.configHash,
            send,
          });
          send({
            type: 'attached',
            protocol: 1,
            brokerPid: process.pid,
            brokerVersion: SERVER_VERSION,
            brokerId: core.brokerId,
            clientId: connection.id,
            defaultProject: connection.defaultProject,
          });
        } catch (error) {
          send({ type: 'attach_error', code: error.code ?? 'ATTACH_FAILED', message: error.message });
          socket.end();
          return;
        }
        continue;
      }
      if (message?.type === 'response_ack') {
        if (message.protocol !== 1) {
          logger.warn('adapter response acknowledgement protocol mismatch', {
            clientId: connection.id,
            protocol: message.protocol,
          });
          continue;
        }
        void core.acknowledgeResponse(connection.id, message).then((acknowledged) => {
          if (!acknowledged) {
            logger.warn('adapter response acknowledgement rejected', {
              clientId: connection.id,
              operationId: message.operationId,
            });
          }
        }).catch((error) => {
          logger.error('adapter response acknowledgement failed', {
            clientId: connection.id,
            operationId: message.operationId,
            message: error.message,
          });
        });
        continue;
      }
      // MCP permits concurrent requests and cancellation must not sit behind
      // the request it is trying to cancel. ProjectScheduler, not the socket
      // reader, owns ordering and fairness.
      void core.handle(connection.id, message).catch((error) => {
        logger.error('unhandled broker request failure', {
          clientId: connection?.id,
          method: message?.method,
          message: error.message,
        });
      });
    }
  });
  socket.on('error', (error) => logger.debug('adapter socket error', { message: error.message }));
  socket.on('end', close);
  socket.on('close', () => {
    sockets.delete(socket);
    bootstrapSockets.delete(socket);
    close();
  });
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
} catch (error) {
  releaseStartupLock(startupLock);
  throw error;
}
chmodSync(socketPath, 0o600);
writeFileSync(pidPath, JSON.stringify({
  pid: process.pid,
  socketPath,
  configHash: fingerprint,
  version: SERVER_VERSION,
  startedAt: new Date().toISOString(),
}) + '\n', { mode: 0o600 });
try {
  expectedAdminToken = await loadOrCreateAdminToken(config.broker.adminTokenFile);
  const journal = await OperationJournal.open(config.broker.journalFile);
  const workspaceStore = await WorkspaceLeaseStore.open(config.broker.workspaceLeaseFile);
  core = new BrokerCore({ config, journal, workspaceStore, logger, configHash: fingerprint });
} catch (error) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => {
    if (!server.listening) resolve();
    else server.close(resolve);
  });
  try {
    const current = JSON.parse(readFileSync(pidPath, 'utf8'));
    if (current.pid === process.pid && existsSync(socketPath)) unlinkSync(socketPath);
    if (current.pid === process.pid && existsSync(pidPath)) unlinkSync(pidPath);
  } catch { /* best effort bootstrap cleanup */ }
  releaseStartupLock(startupLock);
  throw error;
}
for (const socket of bootstrapSockets) socket.resume();
bootstrapSockets.clear();
logger.info('broker listening', { socketPath, configHash: fingerprint });
releaseStartupLock(startupLock);

server.on('error', async (error) => {
  diagnostic(error.message);
  logger.error('broker server error', { code: error.code, message: error.message });
  await shutdown(1);
});

let reauthTimer = null;
if (config.reauthIntervalMin > 0) {
  reauthTimer = setInterval(() => core.auth.status({ force: true }).catch(() => {}), config.reauthIntervalMin * 60_000);
  reauthTimer.unref();
}

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (reauthTimer) clearInterval(reauthTimer);
  await new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  });
  await core?.close().catch((error) => logger.error('broker core close failed', { message: error.message }));
  try {
    const current = JSON.parse(readFileSync(pidPath, 'utf8'));
    if (current.pid === process.pid && existsSync(socketPath)) unlinkSync(socketPath);
    if (current.pid === process.pid && existsSync(pidPath)) unlinkSync(pidPath);
  } catch { /* preserve state owned by another process */ }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { message: error.message, stack: error.stack });
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled rejection', { message: error?.message ?? String(error), stack: error?.stack });
});
