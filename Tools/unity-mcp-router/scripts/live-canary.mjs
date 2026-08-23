#!/usr/bin/env node
/**
 * Guarded live lifecycle canary for an already-installed Unity MCP router.
 *
 * This script never edits a project. It uses the stable stdio adapter, sends
 * each mutation exactly once, and treats every ambiguous/dirty observation as
 * a failure. Run --mode noop before the deliberately reload-producing mode.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { JsonRpcLineDecoder, encodeJsonRpcLine } from '../lib/mcp-framing.mjs';
import {
  MCP_PROTOCOL_VERSION,
  readRouterOperationMeta,
} from '../lib/mcp-protocol.mjs';

export { MCP_PROTOCOL_VERSION };
export const STABLE_ADAPTER_PATH = '/Users/zamgune/.unity-mcp-router/bin/unity-mcp-adapter';
export const REQUIRED_TOOLS = Object.freeze([
  'editor_status',
  'recompile',
  'recompile_status',
  'unity_router_doctor',
  'unity_router_operation_status',
  'unity_router_status',
]);

export const USAGE = `Usage:
  live-canary.mjs --project <alias> --mode <noop|reload> [options]

Options:
  --project <alias>          Required configured project alias
  --mode <noop|reload>       noop accepts only a clean up_to_date result;
                             reload requires a clean completed result
  --adapter <absolute-path>  Stable stdio adapter wrapper
                             (default: ${STABLE_ADAPTER_PATH})
  --timeout-sec <5-600>      Whole-canary deadline (default: 180)
  --settle-ms <100-10000>    Notification quiet window (default: 2000)
  --max-output-bytes <4096-16777216>
                             Per-adapter stdout/stderr bound (default: 8388608)
  --dry-run                  Validate and print the plan without connecting
  --help                     Print this help without connecting

The reload mode dispatches exactly one recompile with force=true. The compat
handler requests a source-neutral clean script compilation within that same
tracked router operation. Mutations are never retried by this harness.`;

export class CanaryPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanaryPolicyError';
    this.exitCode = 2;
  }
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new CanaryPolicyError(`${flag} requires a value`);
  return value;
}

function boundedInteger(raw, flag, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CanaryPolicyError(`${flag} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Pure CLI policy. It performs no filesystem checks and starts no process. */
export function parseCanaryArgs(argv = []) {
  const options = {
    project: null,
    mode: null,
    adapter: STABLE_ADAPTER_PATH,
    timeoutSec: 180,
    settleMs: 2_000,
    maxOutputBytes: 8 * 1024 * 1024,
    dryRun: false,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (['--project', '--mode', '--adapter', '--timeout-sec', '--settle-ms', '--max-output-bytes'].includes(flag)) {
      if (seen.has(flag)) throw new CanaryPolicyError(`${flag} may be specified only once`);
      seen.add(flag);
      const raw = valueAfter(argv, index, flag);
      index += 1;
      if (flag === '--project') options.project = raw;
      else if (flag === '--mode') options.mode = raw;
      else if (flag === '--adapter') options.adapter = raw;
      else if (flag === '--timeout-sec') options.timeoutSec = boundedInteger(raw, flag, 5, 600);
      else if (flag === '--settle-ms') options.settleMs = boundedInteger(raw, flag, 100, 10_000);
      else options.maxOutputBytes = boundedInteger(raw, flag, 4_096, 16 * 1024 * 1024);
    } else throw new CanaryPolicyError(`unknown option: ${flag}`);
  }
  if (options.help) return Object.freeze(options);
  if (!options.project?.trim()) throw new CanaryPolicyError('--project is required');
  if (!['noop', 'reload'].includes(options.mode)) {
    throw new CanaryPolicyError('--mode must be noop or reload');
  }
  if (!options.adapter.startsWith('/')) throw new CanaryPolicyError('--adapter must be an absolute path');
  return Object.freeze({ ...options, project: options.project.trim() });
}

function visitJson(value, visitor, depth = 0, seen = new WeakSet()) {
  if (depth > 10 || value == null) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length > 0 && text.length <= 64 * 1024 && ['{', '['].includes(text[0])) {
      try { visitJson(JSON.parse(text), visitor, depth + 1, seen); } catch { /* ordinary text */ }
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  visitor(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visitJson(child, visitor, depth + 1, seen);
  }
}

/** Extract one unambiguous recompile status record from an MCP tool response. */
export function recompileObservation(response) {
  if (response?.error || response?.result?.isError === true) {
    throw new CanaryPolicyError('recompile tool returned an error');
  }
  const candidates = [];
  const semanticValue = response?.result?.structuredContent;
  const observationSource = semanticValue && typeof semanticValue === 'object' && !Array.isArray(semanticValue)
    ? semanticValue
    : response?.result?.content;
  visitJson(observationSource, (value) => {
    if (typeof value.status !== 'string') return;
    const status = value.status.toLowerCase();
    if (!['triggered', 'compiling', 'completed', 'up_to_date', 'failed', 'error'].includes(status)) return;
    candidates.push({
      status,
      failed: value.failed,
      errors: value.errors,
      isCompiling: value.isCompiling,
    });
  });
  const unique = [...new Map(candidates.map((entry) => [JSON.stringify(entry), entry])).values()];
  if (unique.length !== 1) {
    throw new CanaryPolicyError(`expected one unambiguous recompile status, observed ${unique.length}`);
  }
  return Object.freeze(unique[0]);
}

/** Extract one exact Pipeline editor_status record from an MCP tool response. */
export function editorObservation(response) {
  if (response?.error || response?.result?.isError === true) {
    throw new CanaryPolicyError('editor_status returned an error');
  }
  const candidates = [];
  visitJson(response?.result, (value) => {
    if (
      typeof value.status !== 'string' ||
      typeof value.compiling !== 'boolean' ||
      typeof value.domainReloadInProgress !== 'boolean' ||
      typeof value.playMode !== 'string' ||
      typeof value.projectPath !== 'string'
    ) return;
    candidates.push({
      status: value.status,
      compiling: value.compiling,
      domainReloadInProgress: value.domainReloadInProgress,
      playMode: value.playMode,
      projectPath: value.projectPath,
      unityVersion: value.unityVersion,
    });
  });
  const unique = [...new Map(candidates.map((entry) => [JSON.stringify(entry), entry])).values()];
  if (unique.length !== 1) {
    throw new CanaryPolicyError(`expected one unambiguous editor_status, observed ${unique.length}`);
  }
  return Object.freeze(unique[0]);
}

export function assertEditorReady(observation, expectedProjectPath) {
  const failures = [];
  if (observation?.status !== 'ready') failures.push(`status=${observation?.status ?? 'missing'}`);
  if (observation?.compiling !== false) failures.push('compiling is not false');
  if (observation?.domainReloadInProgress !== false) failures.push('domain reload/update is in progress');
  if (observation?.playMode !== 'stopped') failures.push(`playMode=${observation?.playMode ?? 'missing'}`);
  if (observation?.projectPath !== expectedProjectPath) {
    failures.push(`projectPath=${observation?.projectPath ?? 'missing'}`);
  }
  if (failures.length > 0) throw new CanaryPolicyError(`Editor is not mutation-ready: ${failures.join('; ')}`);
  return observation;
}

export function assertCleanTerminal(observation, mode) {
  const expected = mode === 'noop' ? 'up_to_date' : 'completed';
  if (observation.status !== expected) {
    throw new CanaryPolicyError(`${mode} requires terminal ${expected}, observed ${observation.status}`);
  }
  if (observation.failed !== false || !Array.isArray(observation.errors) || observation.errors.length !== 0) {
    throw new CanaryPolicyError(`${expected} result is not clean`);
  }
  if (observation.isCompiling !== false) {
    throw new CanaryPolicyError(`${expected} result must report isCompiling=false`);
  }
  return observation;
}

/** Accept Pipeline 0.4's intentionally sparse synchronous no-op response. */
export function assertNoopDispatch(observation) {
  if (observation.status !== 'up_to_date') {
    throw new CanaryPolicyError(`noop dispatch must be up_to_date, observed ${observation.status}`);
  }
  if (
    observation.failed === true ||
    (Array.isArray(observation.errors) && observation.errors.length !== 0) ||
    observation.isCompiling === true
  ) throw new CanaryPolicyError('noop dispatch reported dirty or active state');
  return observation;
}

export function assertCleanActiveRecompile(observation) {
  if (!['triggered', 'compiling'].includes(observation.status)) {
    throw new CanaryPolicyError(`reload status is not active: ${observation.status}`);
  }
  if (observation.failed !== false || !Array.isArray(observation.errors) || observation.errors.length !== 0) {
    throw new CanaryPolicyError('active reload status is not clean');
  }
  if (observation.isCompiling !== (observation.status === 'compiling')) {
    throw new CanaryPolicyError('active reload compiling observation is inconsistent');
  }
  return observation;
}

/** Require proof that the reload entered the router's tracked async path. */
export function assertTrackedReloadTrigger(response) {
  const dispatch = classifyReloadDispatch(response);
  if (dispatch.kind !== 'async') {
    throw new CanaryPolicyError('reload completed synchronously instead of entering RUNNING');
  }
  return dispatch.operationId;
}

/**
 * Pipeline 0.4 can either return before a requested compilation starts or hold
 * the command until an already-needed refresh has completed. Both paths are
 * valid, but their router metadata and journal contracts are different.
 */
export function classifyReloadDispatch(response) {
  const observation = recompileObservation(response);
  const semantic = response?.result?.structuredContent;
  const metadata = routerOperationMetadata(response, 'recompile trigger');
  if (typeof metadata.routerOperationId !== 'string' || metadata.routerOperationId.length === 0) {
    throw new CanaryPolicyError('reload operation id is missing');
  }
  if (metadata.routerDeliveryAckRequired !== true) {
    throw new CanaryPolicyError('reload delivery ACK contract is missing');
  }
  if (
    semantic && typeof semantic === 'object' && !Array.isArray(semantic) &&
    Object.hasOwn(semantic, 'routerDeliveryAckRequired')
  ) {
    throw new CanaryPolicyError('reload delivery ACK metadata polluted structuredContent');
  }

  if (['triggered', 'compiling'].includes(observation.status)) {
    assertCleanActiveRecompile(observation);
    if (metadata.routerOperationState !== 'RUNNING') {
      throw new CanaryPolicyError('active reload was not tracked as RUNNING');
    }
    if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic)) {
      throw new CanaryPolicyError('active reload omitted semantic structuredContent');
    }
    if (
      semantic.routerOperationId !== metadata.routerOperationId ||
      semantic.routerOperationState !== metadata.routerOperationState
    ) {
      throw new CanaryPolicyError('active reload semantic metadata does not match router sideband');
    }
    if (semantic.statusTool !== 'recompile_status') {
      throw new CanaryPolicyError('active reload status tool contract is missing');
    }
    return Object.freeze({
      kind: 'async',
      observation,
      operationId: metadata.routerOperationId,
      requireStatusTool: true,
    });
  }

  assertCleanTerminal(observation, 'reload');
  if (metadata.routerOperationState !== 'COMPLETED') {
    throw new CanaryPolicyError('synchronous reload was not reported as COMPLETED');
  }
  if (
    semantic && typeof semantic === 'object' && !Array.isArray(semantic) &&
    ['routerOperationId', 'routerOperationState', 'statusTool'].some((key) => Object.hasOwn(semantic, key))
  ) {
    throw new CanaryPolicyError('synchronous reload must expose router operation data only through _meta');
  }
  return Object.freeze({
    kind: 'synchronous',
    observation,
    operationId: metadata.routerOperationId,
    requireStatusTool: false,
  });
}

export function assertCompletedReloadOperation(
  operation,
  expectedOperationId,
  { requireStatusTool = true } = {},
) {
  if (operation?.operationId !== expectedOperationId) {
    throw new CanaryPolicyError('reload journal operation id does not match the trigger');
  }
  if (
    operation?.method !== 'recompile' ||
    (requireStatusTool && operation?.statusTool !== 'recompile_status') ||
    (!requireStatusTool && Object.hasOwn(operation ?? {}, 'statusTool'))
  ) {
    throw new CanaryPolicyError('reload journal correlation is invalid');
  }
  if (operation?.state !== 'COMPLETED') {
    throw new CanaryPolicyError(`reload journal is not COMPLETED: ${operation?.state ?? 'missing'}`);
  }
  return operation;
}

export function assertNotificationPolicy(mode, counts) {
  const expected = mode === 'noop' ? 0 : 1;
  for (const name of ['clientA', 'clientB']) {
    if (counts?.[name] !== expected) {
      throw new CanaryPolicyError(`${mode} requires ${expected} list_changed for ${name}; observed ${counts?.[name]}`);
    }
  }
  return true;
}

export function selectedProject(snapshot, project) {
  const matches = (snapshot?.projects ?? []).filter((entry) =>
    entry?.name === project || entry?.aliases?.includes(project));
  if (matches.length !== 1) {
    throw new CanaryPolicyError(`status must contain exactly one project for alias ${project}`);
  }
  return matches[0];
}

/** Pure status/doctor cleanup gate used before closeout. */
export function assertCleanRouterState(snapshot, doctor, project) {
  const failures = [];
  if (snapshot?.broker?.draining !== false) failures.push('broker is draining');
  if (snapshot?.budget?.pendingTotal !== 0 || snapshot?.budget?.activeHeavy !== 0) failures.push('global scheduler is busy');
  if (!Array.isArray(snapshot?.leases) || snapshot.leases.length !== 0) failures.push('leases remain');
  if (!Array.isArray(snapshot?.workspaceLeases) || snapshot.workspaceLeases.length !== 0) failures.push('workspace leases remain');
  if (snapshot?.workspaceStore?.ok !== true) failures.push('workspace store is unhealthy');
  if (!Array.isArray(snapshot?.unknownOutcomes) || snapshot.unknownOutcomes.length !== 0) failures.push('unknown outcomes remain');
  if (!Array.isArray(snapshot?.recoveryFaults) || snapshot.recoveryFaults.length !== 0) failures.push('recovery faults remain');
  if (snapshot?.processAudit?.ok !== true) failures.push('status process audit failed');
  if (snapshot?.projectAccess?.ok !== true) failures.push('project access audit failed');
  if (doctor?.ok !== true || doctor?.processAudit?.ok !== true || doctor?.projectAccess?.ok !== true) failures.push('doctor audit failed');
  for (const entry of snapshot?.projects ?? []) {
    if (entry.scheduler && (
      entry.scheduler.pending !== 0 || entry.scheduler.queued !== 0 ||
      entry.scheduler.activeOperationId !== null || entry.scheduler.activeClientId !== null
    )) failures.push(`scheduler is not idle: ${entry.name}`);
    if ((entry.mutationFence?.length ?? 0) !== 0) failures.push(`mutation fence remains: ${entry.name}`);
    if (entry.backgroundOperation != null) failures.push(`background operation remains: ${entry.name}`);
    if ((entry.deliveryPending?.length ?? 0) !== 0) failures.push(`delivery acknowledgement remains: ${entry.name}`);
  }
  const target = selectedProject(snapshot, project);
  if (target.child?.alive !== true || target.child?.ready !== true || !Number.isSafeInteger(target.child?.pid)) {
    failures.push('selected project child is not ready');
  }
  if (failures.length > 0) throw new CanaryPolicyError(failures.join('; '));
  return target;
}

export function assertStableProcesses(before, after, { requireSameChild = true } = {}) {
  if (!Number.isSafeInteger(before?.brokerPid) || before.brokerPid !== after?.brokerPid) {
    throw new CanaryPolicyError(`broker changed (${before?.brokerPid ?? 'none'} -> ${after?.brokerPid ?? 'none'})`);
  }
  if (requireSameChild && (
    !Number.isSafeInteger(before?.childPid) || before.childPid !== after?.childPid
  )) throw new CanaryPolicyError(`Unity child changed (${before?.childPid ?? 'none'} -> ${after?.childPid ?? 'none'})`);
  return true;
}

export function canonicalToolCatalog(response) {
  const tools = response?.result?.tools;
  if (!Array.isArray(tools)) throw new CanaryPolicyError('tools/list did not return a tools array');
  const names = tools.map((tool) => tool?.name);
  const invalidShape = tools.some((tool) =>
    tool == null
    || typeof tool !== 'object'
    || Array.isArray(tool)
    || typeof tool.name !== 'string'
    || tool.name.length === 0
    || tool.inputSchema == null
    || typeof tool.inputSchema !== 'object'
    || Array.isArray(tool.inputSchema));
  if (invalidShape || new Set(names).size !== names.length) {
    throw new CanaryPolicyError('tools/list contains invalid or duplicate tool names');
  }
  return JSON.stringify([...tools].sort((left, right) => left.name.localeCompare(right.name)));
}

export function assertRequiredCatalog(response, mode) {
  const tools = response?.result?.tools ?? [];
  const names = new Set(tools.map((tool) => tool?.name));
  for (const name of REQUIRED_TOOLS) {
    if (!names.has(name)) throw new CanaryPolicyError(`required tool is missing: ${name}`);
  }
  if (mode === 'reload') {
    const recompileTool = tools.find((tool) => tool.name === 'recompile');
    const schema = recompileTool?.inputSchema;
    if (schema?.type !== 'object' || schema?.properties?.force?.type !== 'boolean') {
      throw new CanaryPolicyError('recompile tool does not advertise the opt-in force boolean');
    }
  }
  return canonicalToolCatalog(response);
}

export async function waitForToolCatalog(
  client,
  expectedCatalog,
  deadlineAt,
  { label = 'client', pollMs = 200 } = {},
) {
  let lastCatalog = null;
  for (;;) {
    const response = await client.request('tools/list', {});
    const recovering = response?.error?.data?.brokerCode === 'TOOL_CATALOG_RECOVERING';
    if (!recovering) {
      lastCatalog = canonicalToolCatalog(response);
      if (lastCatalog === expectedCatalog) return response;
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new CanaryPolicyError(`${label} tool catalog did not recover before the canary deadline`);
    }
    await sleep(Math.min(Math.max(1, pollMs), remainingMs));
  }
}

export function structuredContent(response, label) {
  if (response?.error || response?.result?.isError === true) {
    const text = response?.result?.content?.map((part) => part?.text).filter(Boolean).join(' ');
    throw new CanaryPolicyError(`${label} failed${text ? `: ${text}` : ''}`);
  }
  const value = response?.result?.structuredContent;
  if (!value || typeof value !== 'object') throw new CanaryPolicyError(`${label} omitted structuredContent`);
  return value;
}

export function routerOperationMetadata(response, label) {
  if (response?.error || response?.result?.isError === true) {
    const text = response?.result?.content?.map((part) => part?.text).filter(Boolean).join(' ');
    throw new CanaryPolicyError(`${label} failed${text ? `: ${text}` : ''}`);
  }
  const value = readRouterOperationMeta(response?.result);
  if (!value) {
    throw new CanaryPolicyError(`${label} omitted router operation _meta`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StdioCanaryClient {
  constructor({ adapter, project, deadlineAt, maxOutputBytes, name }) {
    this.name = name;
    this.deadlineAt = deadlineAt;
    this.maxOutputBytes = maxOutputBytes;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.closed = false;
    this.decoder = new JsonRpcLineDecoder({ maxLineBytes: maxOutputBytes });
    this.proc = spawn(adapter, ['--default', project], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this.#onStderr(chunk));
    this.exit = new Promise((resolve) => this.proc.once('exit', (code, signal) => {
      if (!this.closed && (code !== 0 || signal != null)) {
        this.#fail(new Error(`${name} adapter exited code=${code} signal=${signal}`));
      }
      resolve({ code, signal });
    }));
    this.proc.once('error', (error) => this.#fail(error));
  }

  #onStdout(chunk) {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.maxOutputBytes) {
      this.#fail(new Error(`${this.name} stdout exceeded ${this.maxOutputBytes} bytes`));
      this.proc.kill('SIGKILL');
      return;
    }
    let messages;
    try { messages = this.decoder.push(chunk); }
    catch (error) { this.#fail(error); return; }
    for (const message of messages) {
      const key = `${typeof message.id}:${String(message.id)}`;
      const pending = this.pending.get(key);
      if (message.id != null && pending) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else if (message.id == null && typeof message.method === 'string') {
        this.notifications.push(message);
      } else this.#fail(new Error(`${this.name} received an unmatched response`));
    }
  }

  #onStderr(chunk) {
    this.stderrBytes += chunk.length;
    const remaining = Math.max(0, this.maxOutputBytes - Buffer.byteLength(this.stderr));
    this.stderr += chunk.subarray(0, remaining).toString('utf8');
    if (this.stderrBytes > this.maxOutputBytes) {
      this.#fail(new Error(`${this.name} stderr exceeded ${this.maxOutputBytes} bytes`));
      this.proc.kill('SIGKILL');
    }
  }

  #fail(error) {
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`${this.name} is closed`));
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('whole-canary deadline expired'));
    const id = this.nextId++;
    const key = `number:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${this.name} ${method} timed out`));
      }, remaining);
      this.pending.set(key, { resolve, reject, timer });
      this.proc.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (error && this.pending.delete(key)) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', method, params }));
  }

  countNotifications(method) {
    return this.notifications.filter((message) => message.method === method).length;
  }

  clearNotifications() { this.notifications.length = 0; }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.name, version: '1' },
    });
    assert.equal(response?.result?.protocolVersion, MCP_PROTOCOL_VERSION, 'protocol version drift');
    assert.equal(
      response?.result?.capabilities?.tools?.listChanged,
      true,
      'server must advertise tools.listChanged=true',
    );
    this.notify('notifications/initialized', {});
    return response;
  }

  async close({ requireGraceful = false } = {}) {
    if (this.closed) return this.exit;
    this.closed = true;
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.name} closed`));
    }
    if (this.proc.exitCode != null || this.proc.signalCode != null) {
      const outcome = await this.exit;
      if (requireGraceful && (outcome.code !== 0 || outcome.signal != null)) {
        throw new CanaryPolicyError(`${this.name} did not close gracefully`);
      }
      return outcome;
    }
    this.proc.stdin.end();
    let outcome = await Promise.race([this.exit, sleep(5_000).then(() => null)]);
    if (outcome) {
      if (requireGraceful && (outcome.code !== 0 || outcome.signal != null)) {
        throw new CanaryPolicyError(`${this.name} did not close gracefully`);
      }
      return outcome;
    }
    this.proc.kill('SIGTERM');
    outcome = await Promise.race([this.exit, sleep(2_000).then(() => null)]);
    if (!outcome) {
      this.proc.kill('SIGKILL');
      outcome = await this.exit;
    }
    if (requireGraceful) throw new CanaryPolicyError(`${this.name} required forced termination`);
    return outcome;
  }
}

async function callTool(client, name, argumentsValue = {}) {
  return client.request('tools/call', { name, arguments: argumentsValue });
}

async function status(client, project) {
  const response = await callTool(client, 'unity_router_status');
  const snapshot = structuredContent(response, 'unity_router_status');
  return { snapshot, target: selectedProject(snapshot, project) };
}

async function waitForReloadTerminal(client, initial, deadlineAt) {
  let observation = recompileObservation(initial);
  assertCleanActiveRecompile(observation);
  while (Date.now() < deadlineAt) {
    await sleep(250);
    observation = recompileObservation(await callTool(client, 'recompile_status'));
    if (observation.status === 'completed') return observation;
    assertCleanActiveRecompile(observation);
  }
  throw new CanaryPolicyError('reload terminal status timed out');
}

async function waitForReloadOperation(
  client,
  operationId,
  deadlineAt,
  { requireStatusTool = true } = {},
) {
  while (Date.now() < deadlineAt) {
    const operation = structuredContent(await callTool(
      client,
      'unity_router_operation_status',
      { operationId },
    ), 'unity_router_operation_status');
    if (
      operation.operationId !== operationId ||
      operation.method !== 'recompile' ||
      (requireStatusTool && operation.statusTool !== 'recompile_status') ||
      (!requireStatusTool && Object.hasOwn(operation, 'statusTool'))
    ) throw new CanaryPolicyError('reload journal correlation is invalid');
    if (operation.state === 'COMPLETED') {
      return assertCompletedReloadOperation(operation, operationId, { requireStatusTool });
    }
    const allowedTransient = requireStatusTool
      ? ['RUNNING']
      : ['RECEIVED', 'QUEUED', 'DISPATCHING'];
    if (!allowedTransient.includes(operation.state)) {
      throw new CanaryPolicyError(`reload journal reached disallowed state: ${operation.state ?? 'missing'}`);
    }
    await sleep(250);
  }
  throw new CanaryPolicyError('reload journal completion timed out');
}

function isBeta3OrNewer(version) {
  const match = /^1\.0\.0-beta\.(\d+)(?:\D|$)/.exec(version ?? '');
  return match != null && Number(match[1]) >= 3;
}

export async function runCanary(options, runtime = {}) {
  const io = runtime.io ?? process;
  if (options.help) { io.stdout.write(`${USAGE}\n`); return { kind: 'help' }; }
  const plan = {
    project: options.project,
    mode: options.mode,
    adapter: options.adapter,
    timeoutSec: options.timeoutSec,
    settleMs: options.settleMs,
    mutationDispatches: 1,
    sourceNeutralForce: options.mode === 'reload',
  };
  if (options.dryRun) {
    io.stdout.write(`${JSON.stringify({ dryRun: true, plan }, null, 2)}\n`);
    return { kind: 'dry-run', plan };
  }

  const deadlineAt = Date.now() + options.timeoutSec * 1_000;
  const makeClient = runtime.clientFactory ?? ((name) => new StdioCanaryClient({
    adapter: options.adapter,
    project: options.project,
    deadlineAt,
    maxOutputBytes: options.maxOutputBytes,
    name,
  }));
  const clients = [];
  let mutationDispatches = 0;
  try {
    const clientA = makeClient('unity-live-canary-a');
    const clientB = makeClient('unity-live-canary-b');
    clients.push(clientA, clientB);
    await Promise.all([clientA.initialize(), clientB.initialize()]);
    const [listA, listB] = await Promise.all([
      clientA.request('tools/list', {}),
      clientB.request('tools/list', {}),
    ]);
    const catalog = assertRequiredCatalog(listA, options.mode);
    assert.equal(assertRequiredCatalog(listB, options.mode), catalog, 'same-project clients received different tools');

    const baselineStatus = await status(clientA, options.project);
    const baselineDoctor = structuredContent(
      await callTool(clientA, 'unity_router_doctor'),
      'baseline unity_router_doctor',
    );
    assertCleanRouterState(baselineStatus.snapshot, baselineDoctor, options.project);
    assertEditorReady(
      editorObservation(await callTool(clientA, 'editor_status', {})),
      baselineStatus.target.path,
    );
    const baselineIdentity = {
      brokerPid: baselineStatus.snapshot.broker?.pid,
      childPid: baselineStatus.target.child?.pid,
    };

    clientA.clearNotifications();
    clientB.clearNotifications();

    mutationDispatches += 1;
    const initial = await callTool(clientA, 'recompile', options.mode === 'reload'
      ? { focus: false, force: true }
      : { focus: false });
    let routerOperationId = null;
    let reloadCompletionPath = null;
    let terminal;
    if (options.mode === 'reload') {
      const dispatch = classifyReloadDispatch(initial);
      routerOperationId = dispatch.operationId;
      reloadCompletionPath = dispatch.kind;
      terminal = dispatch.kind === 'async'
        ? await waitForReloadTerminal(clientA, initial, deadlineAt)
        : dispatch.observation;
      await waitForReloadOperation(clientA, routerOperationId, deadlineAt, {
        requireStatusTool: dispatch.requireStatusTool,
      });
    } else {
      assertNoopDispatch(recompileObservation(initial));
      terminal = recompileObservation(await callTool(clientA, 'recompile_status'));
    }
    assertCleanTerminal(terminal, options.mode);
    await sleep(options.settleMs);
    assertNotificationPolicy(options.mode, {
      clientA: clientA.countNotifications('notifications/tools/list_changed'),
      clientB: clientB.countNotifications('notifications/tools/list_changed'),
    });

    const [afterListA, afterListB] = options.mode === 'reload'
      ? await Promise.all([
          waitForToolCatalog(clientA, catalog, deadlineAt, { label: 'client A' }),
          waitForToolCatalog(clientB, catalog, deadlineAt, { label: 'client B' }),
        ])
      : await Promise.all([
          clientA.request('tools/list', {}),
          clientB.request('tools/list', {}),
        ]);
    assert.equal(canonicalToolCatalog(afterListA), catalog, 'client A tool catalog changed');
    assert.equal(canonicalToolCatalog(afterListB), catalog, 'client B tool catalog changed');
    if (options.mode === 'reload') {
      await sleep(options.settleMs);
      assertNotificationPolicy(options.mode, {
        clientA: clientA.countNotifications('notifications/tools/list_changed'),
        clientB: clientB.countNotifications('notifications/tools/list_changed'),
      });
      const [stableListA, stableListB] = await Promise.all([
        clientA.request('tools/list', {}),
        clientB.request('tools/list', {}),
      ]);
      assert.equal(canonicalToolCatalog(stableListA), catalog, 'client A tool catalog changed after quiet settle');
      assert.equal(canonicalToolCatalog(stableListB), catalog, 'client B tool catalog changed after quiet settle');
    }

    const postReload = await status(clientB, options.project);
    assertStableProcesses(baselineIdentity, {
      brokerPid: postReload.snapshot.broker?.pid,
      childPid: postReload.target.child?.pid,
    }, {
      requireSameChild: options.mode === 'noop' || isBeta3OrNewer(postReload.snapshot.unity?.version),
    });

    await clientA.close({ requireGraceful: true });
    assertEditorReady(
      editorObservation(await callTool(clientB, 'editor_status', {})),
      baselineStatus.target.path,
    );
    const clientC = makeClient('unity-live-canary-reconnect');
    clients.push(clientC);
    await clientC.initialize();
    const reconnectList = await clientC.request('tools/list', {});
    assert.equal(canonicalToolCatalog(reconnectList), catalog, 'reconnected client tool catalog changed');
    assertEditorReady(
      editorObservation(await callTool(clientC, 'editor_status', {})),
      baselineStatus.target.path,
    );

    const doctor = structuredContent(await callTool(clientB, 'unity_router_doctor'), 'unity_router_doctor');
    const finalStatus = await status(clientB, options.project);
    assertCleanRouterState(finalStatus.snapshot, doctor, options.project);
    assertStableProcesses(baselineIdentity, {
      brokerPid: finalStatus.snapshot.broker?.pid,
      childPid: finalStatus.target.child?.pid,
    }, {
      requireSameChild: options.mode === 'noop' || isBeta3OrNewer(finalStatus.snapshot.unity?.version),
    });
    if (mutationDispatches !== 1) throw new CanaryPolicyError('mutation dispatch count drifted from exactly one');

    const report = {
      ok: true,
      project: options.project,
      mode: options.mode,
      protocolVersion: MCP_PROTOCOL_VERSION,
      brokerPid: finalStatus.snapshot.broker.pid,
      childPid: finalStatus.target.child.pid,
      unityVersion: finalStatus.snapshot.unity?.version,
      listChangedPerOriginalClient: options.mode === 'noop' ? 0 : 1,
      mutationDispatches,
      routerOperationId,
      reloadCompletionPath,
      gracefulCloseAndReconnect: true,
      cleanCloseout: true,
    };
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  let options;
  try {
    options = parseCanaryArgs(argv);
    await runCanary(options, runtime);
    return 0;
  } catch (error) {
    const io = runtime.io ?? process;
    io.stderr.write(`live-canary: ${error.message}\n`);
    if (error instanceof CanaryPolicyError) io.stderr.write('Use --help for guarded usage.\n');
    return error.exitCode ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
