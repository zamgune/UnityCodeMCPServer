#!/usr/bin/env node
/**
 * One-shot operational CLI for the shared Unity MCP broker.
 *
 * The CLI always talks through the stdio adapter. It never launches `unity mcp`
 * directly, so the broker remains the sole owner of official Unity CLI child
 * processes.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { JsonRpcLineDecoder, encodeJsonRpcLine } from './lib/mcp-framing.mjs';
import { MCP_PROTOCOL_VERSION } from './lib/mcp-protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ADAPTER = path.join(HERE, 'unity-mcp-router.mjs');
const DEFAULT_REQUEST_TIMEOUT_MS = 310_000;
const CLOSE_GRACE_MS = 2_000;

export const USAGE = `Usage:
  router-cli.mjs [global options] status
  router-cli.mjs [global options] doctor
  router-cli.mjs [global options] drain [timeoutSec]
  router-cli.mjs [global options] resume
  router-cli.mjs [global options] restart [project]
  router-cli.mjs [global options] smoke [project]
  router-cli.mjs [global options] list
  router-cli.mjs [global options] call <tool> [jsonArgs]
  router-cli.mjs [global options] operation status <operationId>
  router-cli.mjs [global options] operation resolve <operationId> <confirmed_completed|abandoned>
  router-cli.mjs [global options] workspace guard [project] -- <command> [args...]
  router-cli.mjs [global options] workspace resolve <leaseToken> --confirm

Global options:
  --config <path>          Forward an explicit router config path
  --broker-mode <mode>     Forward auto or connect-only broker mode
  --default <project>      Select the adapter's default project
  --project <project>      Target a project for smoke, call, list, or guard
  --json                   Print machine-readable JSON

Command options:
  --timeout-sec <seconds>  Drain deadline (1-600)
  --ttl-sec <seconds>      Workspace guard lease TTL (30-3600)
  --confirm                Required for administrative workspace resolution
  --confirm-no-longer-running
                           Required to resolve a RUNNING operation after external verification

With no command, smoke is used. A workspace guard owns and heartbeats one Unity
validation turn, waits for the tracked single-seat Editor handoff, then starts
the guarded command. One-shot begin/heartbeat/end commands are intentionally absent.`;

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = 2;
  }
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) throw new CliUsageError(`${flag} requires a value`);
  return value;
}

function assignOnce(options, key, value, flag) {
  if (options[key] !== undefined) throw new CliUsageError(`${flag} may be specified only once`);
  options[key] = value;
}

function finiteNumber(value, flag, { minimum, maximum }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new CliUsageError(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function mergeProject(positional, flagged, command) {
  if (positional && flagged && positional !== flagged) {
    throw new CliUsageError(`${command} project conflicts with --project (${positional} != ${flagged})`);
  }
  return flagged ?? positional ?? null;
}

function requireNoTokens(tokens, command) {
  if (tokens.length !== 0) throw new CliUsageError(`${command} does not accept: ${tokens.join(' ')}`);
}

function parseJsonObject(raw) {
  if (raw == null) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(`jsonArgs is not valid JSON: ${error.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new CliUsageError('jsonArgs must be a JSON object');
  }
  return value;
}

/** Parse CLI syntax without reading config or starting any process. */
export function parseCliArgs(argv = []) {
  const options = {
    json: false,
    confirm: false,
    confirmNoLongerRunning: false,
    help: false,
    command: null,
    project: undefined,
    configPath: undefined,
    brokerMode: undefined,
    defaultProject: undefined,
    timeoutSec: undefined,
    ttlSec: undefined,
  };
  const tokens = [];
  let afterSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (afterSeparator) {
      tokens.push(token);
      continue;
    }
    if (token === '--') {
      afterSeparator = true;
      tokens.push(token);
      continue;
    }
    if (token === '--json') options.json = true;
    else if (token === '--confirm') options.confirm = true;
    else if (token === '--confirm-no-longer-running') options.confirmNoLongerRunning = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--config') {
      assignOnce(options, 'configPath', valueAfter(argv, index, token), token);
      index += 1;
    } else if (token === '--broker-mode') {
      const mode = valueAfter(argv, index, token);
      if (!['auto', 'connect-only'].includes(mode)) {
        throw new CliUsageError('--broker-mode must be auto or connect-only');
      }
      assignOnce(options, 'brokerMode', mode, token);
      index += 1;
    } else if (token === '--default') {
      assignOnce(options, 'defaultProject', valueAfter(argv, index, token), token);
      index += 1;
    } else if (token === '--project') {
      assignOnce(options, 'project', valueAfter(argv, index, token), token);
      index += 1;
    } else if (token === '--timeout-sec') {
      assignOnce(options, 'timeoutSec', finiteNumber(
        valueAfter(argv, index, token), token, { minimum: 1, maximum: 600 },
      ), token);
      index += 1;
    } else if (token === '--ttl-sec') {
      assignOnce(options, 'ttlSec', finiteNumber(
        valueAfter(argv, index, token), token, { minimum: 30, maximum: 3600 },
      ), token);
      index += 1;
    } else tokens.push(token);
  }

  if (options.help) return { ...options, command: 'help' };

  let command = tokens.shift() ?? 'smoke';
  // Convenient spellings for scripts while keeping the documented hierarchy.
  if (command === 'workspace-guard') {
    tokens.unshift('guard');
    command = 'workspace';
  }
  if (command === 'workspace-resolve') {
    tokens.unshift('resolve');
    command = 'workspace';
  }
  options.command = command;

  if (command === 'status' || command === 'doctor' || command === 'resume' || command === 'list') {
    requireNoTokens(tokens, command);
  } else if (command === 'drain') {
    if (tokens.length > 1) throw new CliUsageError('drain accepts at most one timeoutSec');
    if (tokens.length === 1) {
      const positional = finiteNumber(tokens[0], 'timeoutSec', { minimum: 1, maximum: 600 });
      if (options.timeoutSec !== undefined && positional !== options.timeoutSec) {
        throw new CliUsageError('drain timeoutSec conflicts with --timeout-sec');
      }
      options.timeoutSec = positional;
    }
  } else if (command === 'smoke') {
    if (tokens.length > 1) throw new CliUsageError('smoke accepts at most one project');
    options.project = mergeProject(tokens[0], options.project, 'smoke');
  } else if (command === 'call') {
    if (tokens.length < 1 || tokens.length > 2) {
      throw new CliUsageError('call requires <tool> and accepts one optional jsonArgs object');
    }
    options.tool = tokens[0];
    options.toolArgs = parseJsonObject(tokens[1]);
    if (options.project) {
      if (options.toolArgs.project != null && options.toolArgs.project !== options.project) {
        throw new CliUsageError('jsonArgs.project conflicts with --project');
      }
      options.toolArgs.project = options.project;
    }
  } else if (command === 'restart') {
    if (tokens.length > 1) throw new CliUsageError('restart accepts at most one project');
    options.project = mergeProject(tokens[0], options.project, 'restart');
  } else if (command === 'operation') {
    const action = tokens.shift();
    options.operationAction = action;
    if (action === 'status') {
      if (tokens.length !== 1) throw new CliUsageError('operation status requires one operationId');
      options.operationId = tokens[0];
    } else if (action === 'resolve') {
      if (tokens.length !== 2) {
        throw new CliUsageError('operation resolve requires operationId and confirmed_completed or abandoned');
      }
      options.operationId = tokens[0];
      options.resolution = tokens[1];
      if (!['confirmed_completed', 'abandoned'].includes(options.resolution)) {
        throw new CliUsageError('operation resolution must be confirmed_completed or abandoned');
      }
    } else {
      throw new CliUsageError('operation action must be status or resolve');
    }
  } else if (command === 'workspace') {
    const action = tokens.shift();
    options.workspaceAction = action;
    if (action === 'guard') {
      const separator = tokens.indexOf('--');
      if (separator < 0) {
        throw new CliUsageError('workspace guard requires -- before the guarded command');
      }
      const before = tokens.slice(0, separator);
      const guarded = tokens.slice(separator + 1);
      if (before.length > 1) throw new CliUsageError('workspace guard accepts at most one project');
      if (guarded.length === 0) throw new CliUsageError('workspace guard requires a command after --');
      options.project = mergeProject(before[0], options.project, 'workspace guard');
      options.guardedCommand = guarded[0];
      options.guardedArgs = guarded.slice(1);
    } else if (action === 'resolve') {
      if (tokens.length !== 1) throw new CliUsageError('workspace resolve requires one leaseToken');
      if (!options.confirm) throw new CliUsageError('workspace resolve requires --confirm');
      options.leaseToken = tokens[0];
    } else {
      throw new CliUsageError('workspace action must be guard or resolve');
    }
  } else {
    throw new CliUsageError(`unknown command: ${command}`);
  }

  if (command !== 'drain' && options.timeoutSec !== undefined) {
    throw new CliUsageError('--timeout-sec is valid only with drain');
  }
  if (!(command === 'workspace' && options.workspaceAction === 'guard') && options.ttlSec !== undefined) {
    throw new CliUsageError('--ttl-sec is valid only with workspace guard');
  }
  if (!(command === 'workspace' && options.workspaceAction === 'resolve') && options.confirm) {
    throw new CliUsageError('--confirm is valid only with workspace resolve');
  }
  if (!(command === 'operation' && options.operationAction === 'resolve') && options.confirmNoLongerRunning) {
    throw new CliUsageError('--confirm-no-longer-running is valid only with operation resolve');
  }
  return options;
}

/** Build only adapter arguments; command-specific flags never leak into config parsing. */
export function buildRouterArgs(options, adapterPath = DEFAULT_ADAPTER) {
  const args = [adapterPath];
  const administrative = options.command === 'drain' || options.command === 'resume' ||
    options.command === 'restart' ||
    (options.command === 'workspace' && options.workspaceAction === 'resolve') ||
    (options.command === 'operation' && options.operationAction === 'resolve');
  // `call` is deliberately not elevated: admin tools require their dedicated
  // command and its explicit confirmation syntax.
  if (administrative) args.push('--admin');
  if (options.configPath !== undefined) args.push('--config', options.configPath);
  if (options.brokerMode !== undefined) args.push('--broker-mode', options.brokerMode);
  const effectiveDefault = options.defaultProject ?? options.project;
  if (effectiveDefault) args.push('--default', effectiveDefault);
  return args;
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

/** Small newline-framed JSON-RPC client around one stdio adapter process. */
export class RouterSession {
  constructor(child, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.decoder = new JsonRpcLineDecoder();
    this.closed = false;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });

    child.stdout.on('data', (chunk) => {
      let messages;
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        this.#failAll(new Error(`router stdout framing failed: ${error.message}`));
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        return;
      }
      for (const message of messages) {
        if (message?.id == null) continue;
        const entry = this.pending.get(requestKey(message.id));
        if (!entry) continue;
        this.pending.delete(requestKey(message.id));
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    });
    child.stdout.on('end', () => {
      try { this.decoder.end(); }
      catch (error) { this.#failAll(new Error(`router stdout framing failed: ${error.message}`)); }
    });
    child.once('error', (error) => this.#failAll(new Error(`cannot start router adapter: ${error.message}`)));
    child.once('exit', (code, signal) => {
      this.closed = true;
      this.#failAll(new Error(`router adapter exited (${signal ?? code ?? 'unknown'})`));
      this.resolveExit({ code, signal });
    });
    child.once('close', (code, signal) => {
      if (!this.closed) {
        this.#failAll(new Error(`router adapter closed (${signal ?? code ?? 'unknown'})`));
      }
      this.closed = true;
      this.resolveExit({ code, signal });
    });
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('router adapter is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id));
        try {
          this.child.stdin.write(encodeJsonRpcLine({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'router-cli request timeout' },
          }));
        } catch { /* the adapter may already be gone */ }
        reject(new Error(`${method} timed out after ${Math.ceil(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(requestKey(id), { resolve, reject, timer });
      try {
        this.child.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestKey(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) throw new Error('router adapter is closed');
    this.child.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', method, params }));
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'router-cli', version: '2' },
    });
    if (response.error) throw new Error(`initialize failed: ${response.error.message}`);
    this.notify('notifications/initialized', {});
    return response.result;
  }

  async close() {
    if (this.closed) return;
    try { this.child.stdin.end(); } catch { /* already gone */ }
    let graceTimer;
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (!exited) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
      let killTimer;
      await Promise.race([
        this.exitPromise,
        new Promise((resolve) => {
          killTimer = setTimeout(resolve, 1_000);
          killTimer.unref?.();
        }),
      ]);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  #failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((entry) => entry?.text ?? '').filter(Boolean).join('\n');
}

function printableResult(result, json) {
  if (json) return JSON.stringify(result, null, 2);
  return resultText(result) || JSON.stringify(result, null, 2);
}

async function invokeTool(session, name, args, { timeoutMs } = {}) {
  const response = await session.request('tools/call', { name, arguments: args }, { timeoutMs });
  if (response.error) {
    return { ok: false, output: `error: ${response.error.message}`, error: response.error, result: null };
  }
  return {
    ok: !response.result?.isError,
    output: printableResult(response.result, false),
    result: response.result,
  };
}

function writeLine(stream, value = '') {
  stream.write(`${value}\n`);
}

function emitWorkspaceEvent(io, json, event, details) {
  if (json) writeLine(io.stdout, JSON.stringify({ event, ...details }));
  else writeLine(io.stdout, `[workspace] ${details.message}`);
}

function commandExit(child, spawnError) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', (error) => {
      spawnError.current = error;
      finish({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => finish({ code, signal, error: null }));
  });
}

async function runWorkspaceGuard(options, session, runtime) {
  const ttlSec = options.ttlSec ?? 600;
  const begin = await invokeTool(session, 'unity_router_workspace_begin', {
    ...(options.project ? { project: options.project } : {}),
    ttlSec,
  });
  if (!begin.ok) {
    writeLine(runtime.io.stderr, begin.output);
    return 1;
  }
  let lease = begin.result?.structuredContent;
  if (!lease || typeof lease !== 'object') {
    try { lease = JSON.parse(resultText(begin.result)); }
    catch { lease = null; }
  }
  const token = lease?.token;
  if (typeof token !== 'string' || token.length === 0) {
    writeLine(runtime.io.stderr, 'workspace begin succeeded without a lease token; refusing to run the command');
    return 1;
  }

  emitWorkspaceEvent(runtime.io, options.json, 'acquired', {
    token,
    project: lease.project ?? options.project ?? null,
    expiresAt: lease.expiresAt ?? null,
    message: `lease acquired for ${lease.project ?? options.project ?? 'default project'} (token ${token})`,
  });

  const intervalMs = runtime.workspaceHeartbeatIntervalMs ??
    Math.max(10_000, Math.min(60_000, Math.floor(ttlSec * 1000 / 3)));
  const leaseCallTimeoutMs = Math.max(5_000, Math.min(30_000, intervalMs));
  const releaseBeforeCommand = async (reason) => {
    const end = await invokeTool(
      session,
      'unity_router_workspace_end',
      { leaseToken: token },
      { timeoutMs: leaseCallTimeoutMs },
    ).catch((error) => ({ ok: false, output: error.message }));
    if (!end.ok) {
      writeLine(runtime.io.stderr,
        `${reason}\nworkspace release failed for token ${token}: ${end.output}\n` +
        `After verifying the Editor handoff is terminal, run: workspace resolve ${token} --confirm`);
      return 1;
    }
    emitWorkspaceEvent(runtime.io, options.json, 'released', {
      token,
      project: lease.project ?? options.project ?? null,
      message: `lease released before guarded command (token ${token})`,
    });
    writeLine(runtime.io.stderr, reason);
    return 1;
  };

  let editorUse = lease.editorUse;
  if (editorUse && typeof editorUse === 'object') {
    const failedStates = new Set(['BLOCKED', 'CANCELLED', 'FAILED', 'UNKNOWN_OUTCOME']);
    let lastState = null;
    let nextHeartbeatAt = Date.now() + intervalMs;
    let interruptedBy = null;
    const activationSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const activationHandlers = new Map(activationSignals.map((signal) => [signal, () => {
      interruptedBy ??= signal;
    }]));
    for (const [signal, handler] of activationHandlers) runtime.signalEmitter.on(signal, handler);
    try {
      for (;;) {
        if (editorUse.state !== lastState) {
          lastState = editorUse.state;
          const manual = editorUse.state === 'WAITING_MANUAL_CLOSE'
            ? ' Close the currently active Unity Editor normally; the target will open automatically.'
            : '';
          emitWorkspaceEvent(runtime.io, options.json, 'editor-use', {
            operationId: editorUse.operationId ?? null,
            state: editorUse.state,
            blockers: editorUse.blockers ?? [],
            message: `Editor handoff is ${editorUse.state}.${manual}`,
          });
        }
        if (editorUse.state === 'COMPLETED') break;
        if (failedStates.has(editorUse.state)) {
          return releaseBeforeCommand(
            `Editor handoff did not become ready (${editorUse.state}: ` +
              `${(editorUse.blockers ?? []).join(', ') || 'no details'}). Guarded command was not started.`,
          );
        }
        if (interruptedBy) {
          return releaseBeforeCommand(
            `Editor handoff wait was interrupted by ${interruptedBy}. Guarded command was not started.`,
          );
        }
        if (Date.now() >= nextHeartbeatAt) {
          const heartbeat = await invokeTool(
            session,
            'unity_router_workspace_heartbeat',
            { leaseToken: token, ttlSec },
            { timeoutMs: leaseCallTimeoutMs },
          );
          if (!heartbeat.ok) {
            return releaseBeforeCommand(
              `workspace heartbeat failed while waiting for Editor handoff: ${heartbeat.output}`,
            );
          }
          nextHeartbeatAt = Date.now() + intervalMs;
        }
        if (typeof editorUse.operationId !== 'string' || editorUse.operationId.length === 0) {
          return releaseBeforeCommand('Editor handoff did not provide a tracked operation id.');
        }
        await new Promise((resolve) => setTimeout(resolve, runtime.editorUsePollIntervalMs ?? 250));
        const observed = await invokeTool(
          session,
          'unity_router_editor_use_status',
          { operationId: editorUse.operationId },
          { timeoutMs: leaseCallTimeoutMs },
        );
        if (!observed.ok) {
          return releaseBeforeCommand(`Editor handoff status failed: ${observed.output}`);
        }
        editorUse = observed.result?.structuredContent;
        if (!editorUse || typeof editorUse !== 'object') {
          return releaseBeforeCommand('Editor handoff status returned no structured state.');
        }
      }
    } finally {
      for (const [signal, handler] of activationHandlers) runtime.signalEmitter.off(signal, handler);
    }
  }

  let child;
  try {
    child = runtime.spawnCommand(options.guardedCommand, options.guardedArgs, {
      stdio: 'inherit',
      cwd: runtime.cwd,
      env: runtime.env,
    });
  } catch (error) {
    child = null;
    writeLine(runtime.io.stderr, `cannot start guarded command: ${error.message}`);
  }

  let stopping = false;
  let heartbeatTimer = null;
  let heartbeatInFlight = null;
  let heartbeatFailure = null;
  let forceKillTimer = null;
  const spawnError = { current: null };
  const terminateChild = () => {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGTERM'); } catch { /* child already exited */ }
    if (typeof child.kill === 'function') {
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* child already exited */ }
      }, 5_000);
      forceKillTimer.unref?.();
    }
  };

  const scheduleHeartbeat = () => {
    if (stopping) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatInFlight = (async () => {
        const heartbeat = await invokeTool(
          session,
          'unity_router_workspace_heartbeat',
          { leaseToken: token, ttlSec },
          { timeoutMs: leaseCallTimeoutMs },
        );
        if (!heartbeat.ok) throw new Error(heartbeat.output);
      })().catch((error) => {
        heartbeatFailure = error;
        writeLine(runtime.io.stderr, `workspace heartbeat failed; terminating guarded command: ${error.message}`);
        terminateChild();
      }).finally(() => {
        heartbeatInFlight = null;
        scheduleHeartbeat();
      });
    }, intervalMs);
    heartbeatTimer.unref?.();
  };

  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = new Map(forwardedSignals.map((signal) => [signal, () => {
    if (!child) return;
    try { child.kill(signal); } catch { /* child already exited */ }
  }]));
  for (const [signal, handler] of signalHandlers) runtime.signalEmitter.on(signal, handler);

  let childResult = { code: 1, signal: null, error: new Error('guarded command did not start') };
  try {
    if (child) {
      scheduleHeartbeat();
      childResult = await commandExit(child, spawnError);
    }
  } finally {
    stopping = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (heartbeatInFlight) await heartbeatInFlight;
    for (const [signal, handler] of signalHandlers) runtime.signalEmitter.off(signal, handler);
  }

  let end;
  try {
    end = await invokeTool(
      session,
      'unity_router_workspace_end',
      { leaseToken: token },
      { timeoutMs: leaseCallTimeoutMs },
    );
  } catch (error) {
    end = { ok: false, output: error.message };
  }
  if (!end.ok) {
    const code = end.result?.structuredContent?.code ?? end.error?.data?.code;
    const asyncGuidance = code === 'WORKSPACE_ASYNC_ACTIVE'
      ? '\nA tracked Unity operation is still RUNNING. Do not administratively resolve the lease yet. ' +
        'Poll router/operation status until it is terminal; a persistent MCP owner must then call workspace_end in the same session.'
      : '';
    writeLine(runtime.io.stderr,
      `workspace release failed for token ${token}: ${end.output}${asyncGuidance}\n` +
      `After verifying all tracked work and Unity import/compile are idle, run: workspace resolve ${token} --confirm`);
    return 1;
  }
  emitWorkspaceEvent(runtime.io, options.json, 'released', {
    token,
    project: lease.project ?? options.project ?? null,
    message: `lease released (token ${token})`,
  });

  if (spawnError.current) {
    writeLine(runtime.io.stderr, `guarded command failed to start: ${spawnError.current.message}`);
    return 1;
  }
  if (heartbeatFailure) return 1;
  if (childResult.signal) {
    writeLine(runtime.io.stderr, `guarded command exited on ${childResult.signal}`);
    return 1;
  }
  return Number.isInteger(childResult.code) && childResult.code === 0 ? 0 : (childResult.code || 1);
}

/** Execute one parsed command against an already initialized router session. */
export async function executeCommand(options, session, runtime = {}) {
  const io = runtime.io ?? { stdout: process.stdout, stderr: process.stderr };
  const commandRuntime = {
    io,
    spawnCommand: runtime.spawnCommand ?? spawn,
    signalEmitter: runtime.signalEmitter ?? process,
    env: runtime.env ?? process.env,
    workspaceHeartbeatIntervalMs: runtime.workspaceHeartbeatIntervalMs,
    editorUsePollIntervalMs: runtime.editorUsePollIntervalMs,
  };

  if (options.command === 'help') {
    writeLine(io.stdout, USAGE);
    return 0;
  }
  if (options.command === 'list') {
    const response = await session.request('tools/list', {});
    if (response.error) {
      writeLine(io.stderr, response.error.message);
      return 1;
    }
    if (options.json) writeLine(io.stdout, JSON.stringify(response.result, null, 2));
    else for (const tool of response.result?.tools ?? []) {
      writeLine(io.stdout, `${tool.name}\t${(tool.description ?? '').split('\n')[0]}`);
    }
    return 0;
  }
  if (options.command === 'call') {
    const call = await invokeTool(session, options.tool, options.toolArgs);
    writeLine(call.ok ? io.stdout : io.stderr, options.json && call.result
      ? JSON.stringify(call.result, null, 2) : call.output);
    return call.ok ? 0 : 1;
  }
  if (options.command === 'smoke') {
    const calls = [
      ['unity_router_status', {}],
      ['unity_router_doctor', {}],
      ['editor_status', options.project ? { project: options.project } : {}],
    ];
    const results = [];
    for (const [name, args] of calls) {
      const call = await invokeTool(session, name, args);
      results.push({ tool: name, ok: call.ok, result: call.result, error: call.error });
      if (!options.json) {
        writeLine(io.stdout, `\n-- ${name}${args.project ? ` (${args.project})` : ''}`);
        writeLine(call.ok ? io.stdout : io.stderr, call.output);
      }
    }
    const ok = results.every((entry) => entry.ok);
    if (options.json) writeLine(io.stdout, JSON.stringify({ ok, checks: results }, null, 2));
    else writeLine(io.stdout, `\n${ok ? 'PASS' : 'FAIL'}`);
    return ok ? 0 : 1;
  }
  if (options.command === 'workspace' && options.workspaceAction === 'guard') {
    return runWorkspaceGuard(options, session, {
      ...commandRuntime,
      // Only a guarded workspace command needs the caller's checkout cwd.
      // Status/doctor must remain usable when that removable volume is stalled.
      cwd: runtime.cwd ?? process.cwd(),
    });
  }

  let native = null;
  if (options.command === 'status') native = ['unity_router_status', {}];
  else if (options.command === 'doctor') native = ['unity_router_doctor', {}];
  else if (options.command === 'drain') {
    native = ['unity_router_drain', options.timeoutSec === undefined ? {} : { timeoutSec: options.timeoutSec }];
  } else if (options.command === 'resume') native = ['unity_router_resume', {}];
  else if (options.command === 'restart') {
    native = ['unity_router_restart', options.project ? { project: options.project } : {}];
  } else if (options.command === 'operation' && options.operationAction === 'status') {
    native = ['unity_router_operation_status', { operationId: options.operationId }];
  } else if (options.command === 'operation' && options.operationAction === 'resolve') {
    native = ['unity_router_operation_resolve', {
      operationId: options.operationId,
      resolution: options.resolution,
      ...(options.confirmNoLongerRunning ? { confirmNoLongerRunning: true } : {}),
    }];
  } else if (options.command === 'workspace' && options.workspaceAction === 'resolve') {
    native = ['unity_router_workspace_resolve', { leaseToken: options.leaseToken, confirm: true }];
  }
  if (!native) throw new CliUsageError(`unsupported command: ${options.command}`);
  const timeoutMs = options.command === 'drain' ? ((options.timeoutSec ?? 60) + 10) * 1000 : undefined;
  const call = await invokeTool(session, native[0], native[1], { timeoutMs });
  writeLine(call.ok ? io.stdout : io.stderr, options.json && call.result
    ? JSON.stringify(call.result, null, 2) : call.output);
  return call.ok ? 0 : 1;
}

export async function runCli(argv = process.argv.slice(2), runtime = {}) {
  const io = runtime.io ?? { stdout: process.stdout, stderr: process.stderr };
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    writeLine(io.stderr, error.message);
    writeLine(io.stderr, USAGE);
    return error instanceof CliUsageError ? error.exitCode : 1;
  }
  if (options.command === 'help') {
    writeLine(io.stdout, USAGE);
    return 0;
  }

  let child;
  try {
    child = (runtime.spawnAdapter ?? spawn)(
      runtime.nodePath ?? process.execPath,
      buildRouterArgs(options, runtime.adapterPath ?? DEFAULT_ADAPTER),
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...(runtime.env ?? process.env),
          UNITY_MCP_REQUIRE_PREPARED_CONFIG: '1',
        },
        cwd: runtime.adapterCwd ?? HERE,
      },
    );
  } catch (error) {
    writeLine(io.stderr, `cannot start router adapter: ${error.message}`);
    return 1;
  }
  const session = new RouterSession(child, { requestTimeoutMs: runtime.requestTimeoutMs });
  try {
    await session.initialize();
    return await executeCommand(options, session, { ...runtime, io });
  } catch (error) {
    writeLine(io.stderr, error.message);
    return 1;
  } finally {
    await session.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli();
}
