#!/usr/bin/env node
/**
 * Persistent two-client, single-Editor soak for an already-installed router.
 *
 * The default run is deliberately one hour. Safe reads and evidence snapshots
 * are always enabled; every state-changing action is opt-in and dispatched at
 * most once. The harness never edits or cleans a Unity checkout.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as FS_CONSTANTS,
  createReadStream,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { JsonRpcLineDecoder, encodeJsonRpcLine } from '../lib/mcp-framing.mjs';
import { readRouterOperationMeta } from '../lib/mcp-protocol.mjs';
import {
  MCP_PROTOCOL_VERSION,
  STABLE_ADAPTER_PATH,
  assertCleanActiveRecompile,
  assertCleanRouterState,
  assertCleanTerminal,
  assertCompletedReloadOperation,
  assertEditorReady,
  assertNoopDispatch,
  assertRequiredCatalog,
  canonicalToolCatalog,
  classifyReloadDispatch,
  editorObservation,
  recompileObservation,
  selectedProject,
} from './live-canary.mjs';

export const DEFAULT_DURATION_SEC = 3_600;
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
export const SAFE_READ_INTERVAL_MS = 60_000;
export const RELOAD_AT_MS = 15 * 60_000;
export const RECONNECT_AT_MS = 20 * 60_000;
export const RESTART_AT_MS = 30 * 60_000;
export const FAIRNESS_AT_MS = 40 * 60_000;
export const NOTIFICATION_ALLOWLIST = Object.freeze(new Set([
  'notifications/tools/list_changed',
]));
export const CLIENT_NAMES = Object.freeze({
  codex: 'Codex Unity Soak',
  claude: 'Claude Code Unity Soak',
});

export const USAGE = `Usage:
  live-soak.mjs --project <alias> --project-path <canonical-path> --evidence <new-jsonl> [options]

Required:
  --project <alias>             Configured project alias
  --project-path <absolute>     Exact canonical Unity project path
  --evidence <absolute>         New JSONL file; existing paths and symlinks fail

Options:
  --adapter <absolute>          Stable stdio adapter (default: ${STABLE_ADAPTER_PATH})
  --duration-sec <3600-21600>   Soak duration (default: 3600)
  --request-timeout-sec <5-120> Safe-read/request bound (default: 30)
  --operation-timeout-sec <60-600>
                                Bound for each opt-in operation (default: 300)
  --settle-ms <100-10000>       Notification quiet window (default: 2000)
  --max-output-bytes <4096-16777216>
                                Per-adapter protocol byte bound (default: 8388608)
  --with-reload                 Exactly one force=true source-neutral reload at 15m
  --with-restart                Exactly one controlled project-child restart at 30m
  --fairness-burst <2-20>       Even number of simultaneous no-force recompile no-ops at 40m
  --dry-run                     Fingerprint inputs and print the exact plan; do not connect,
                                create evidence, or dispatch any mutation
  --help                        Print this help

The always-on reconnect closes and recreates only the Claude-like adapter at
20m. Mutations are never retried. If any opt-in mutation has an ambiguous
result, the run fails and leaves broker/journal fences intact for inspection.`;

export class SoakPolicyError extends Error {
  constructor(message, code = 'SOAK_POLICY_ERROR') {
    super(message);
    this.name = 'SoakPolicyError';
    this.code = code;
    this.exitCode = 2;
  }
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) throw new SoakPolicyError(`${flag} requires a value`);
  return value;
}

function boundedInteger(raw, flag, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SoakPolicyError(`${flag} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Pure CLI policy: no filesystem access, process launch, or mutation. */
export function parseSoakArgs(argv = []) {
  const options = {
    project: null,
    projectPath: null,
    evidence: null,
    adapter: STABLE_ADAPTER_PATH,
    durationSec: DEFAULT_DURATION_SEC,
    requestTimeoutSec: 30,
    operationTimeoutSec: 300,
    settleMs: 2_000,
    maxOutputBytes: 8 * 1024 * 1024,
    withReload: false,
    withRestart: false,
    fairnessBurst: 0,
    dryRun: false,
    help: false,
  };
  const seen = new Set();
  const valued = new Set([
    '--project', '--project-path', '--evidence', '--adapter', '--duration-sec',
    '--request-timeout-sec', '--operation-timeout-sec', '--settle-ms',
    '--max-output-bytes', '--fairness-burst',
  ]);
  const booleans = new Set(['--with-reload', '--with-restart', '--dry-run', '--help', '-h']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valued.has(flag) && !booleans.has(flag)) throw new SoakPolicyError(`unknown option: ${flag}`);
    const canonicalFlag = flag === '-h' ? '--help' : flag;
    if (seen.has(canonicalFlag)) throw new SoakPolicyError(`${canonicalFlag} may be specified only once`);
    seen.add(canonicalFlag);
    if (valued.has(flag)) {
      const raw = valueAfter(argv, index, flag);
      index += 1;
      if (flag === '--project') options.project = raw;
      else if (flag === '--project-path') options.projectPath = raw;
      else if (flag === '--evidence') options.evidence = raw;
      else if (flag === '--adapter') options.adapter = raw;
      else if (flag === '--duration-sec') options.durationSec = boundedInteger(raw, flag, 3_600, 21_600);
      else if (flag === '--request-timeout-sec') options.requestTimeoutSec = boundedInteger(raw, flag, 5, 120);
      else if (flag === '--operation-timeout-sec') options.operationTimeoutSec = boundedInteger(raw, flag, 60, 600);
      else if (flag === '--settle-ms') options.settleMs = boundedInteger(raw, flag, 100, 10_000);
      else if (flag === '--max-output-bytes') options.maxOutputBytes = boundedInteger(raw, flag, 4_096, 16 * 1024 * 1024);
      else options.fairnessBurst = boundedInteger(raw, flag, 2, 20);
    } else if (canonicalFlag === '--with-reload') options.withReload = true;
    else if (canonicalFlag === '--with-restart') options.withRestart = true;
    else if (canonicalFlag === '--dry-run') options.dryRun = true;
    else options.help = true;
  }
  if (options.help) return Object.freeze(options);
  if (!options.project?.trim()) throw new SoakPolicyError('--project is required');
  for (const [flag, value] of [
    ['--project-path', options.projectPath],
    ['--evidence', options.evidence],
    ['--adapter', options.adapter],
  ]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new SoakPolicyError(`${flag} must be an absolute path`);
    }
  }
  if (options.fairnessBurst % 2 !== 0) {
    throw new SoakPolicyError('--fairness-burst must be even so Codex and Claude receive equal work');
  }
  return Object.freeze({
    ...options,
    project: options.project.trim(),
    projectPath: path.resolve(options.projectPath),
    evidence: path.resolve(options.evidence),
    adapter: path.resolve(options.adapter),
  });
}

function scheduledCount(durationMs, intervalMs) {
  return Math.max(0, Math.ceil(durationMs / intervalMs) - 1);
}

export function buildSoakPlan(options, timing = {}) {
  const durationMs = options.durationSec * 1_000;
  const snapshotIntervalMs = timing.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
  const safeReadIntervalMs = timing.safeReadIntervalMs ?? SAFE_READ_INTERVAL_MS;
  const mutationDispatches = {
    reload: options.withReload ? 1 : 0,
    fairnessNoopRecompile: options.fairnessBurst,
    controlledChildRestart: options.withRestart ? 1 : 0,
  };
  return Object.freeze({
    project: options.project,
    projectPath: options.projectPath,
    evidence: options.evidence,
    adapter: options.adapter,
    durationSec: options.durationSec,
    persistentClients: [CLIENT_NAMES.codex, CLIENT_NAMES.claude],
    safeReadIntervalSec: safeReadIntervalMs / 1_000,
    snapshotIntervalSec: snapshotIntervalMs / 1_000,
    maximumPeriodicDispatchDriftSec:
      (timing.maxScheduleDriftMs ?? Math.min(30_000, options.requestTimeoutSec * 1_000)) / 1_000,
    expectedJsonlSnapshots: scheduledCount(durationMs, snapshotIntervalMs) + 2,
    expectedSimultaneousReadRounds: scheduledCount(durationMs, safeReadIntervalMs) + 2,
    reconnects: 1,
    mutationDispatches,
    totalUnityMutationDispatches: mutationDispatches.reload + mutationDispatches.fairnessNoopRecompile,
    totalAdministrativeMutationDispatches: mutationDispatches.controlledChildRestart,
    mutationRetries: 0,
    sourceWrites: 0,
    scheduleSec: {
      reload: options.withReload ? (timing.reloadAtMs ?? RELOAD_AT_MS) / 1_000 : null,
      reconnect: (timing.reconnectAtMs ?? RECONNECT_AT_MS) / 1_000,
      childRestart: options.withRestart ? (timing.restartAtMs ?? RESTART_AT_MS) / 1_000 : null,
      fairnessBurst: options.fairnessBurst > 0 ? (timing.fairnessAtMs ?? FAIRNESS_AT_MS) / 1_000 : null,
    },
  });
}

export function buildSoakSchedule(options, timing = {}) {
  const durationMs = options.durationSec * 1_000;
  const events = [];
  const safeReadIntervalMs = timing.safeReadIntervalMs ?? SAFE_READ_INTERVAL_MS;
  const snapshotIntervalMs = timing.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
  for (let atMs = safeReadIntervalMs; atMs < durationMs; atMs += safeReadIntervalMs) {
    events.push({ kind: 'safe-read', atMs, priority: 10 });
  }
  if (options.withReload) events.push({ kind: 'reload', atMs: timing.reloadAtMs ?? RELOAD_AT_MS, priority: 20 });
  events.push({ kind: 'reconnect', atMs: timing.reconnectAtMs ?? RECONNECT_AT_MS, priority: 20 });
  if (options.withRestart) events.push({ kind: 'restart', atMs: timing.restartAtMs ?? RESTART_AT_MS, priority: 20 });
  if (options.fairnessBurst > 0) events.push({ kind: 'fairness', atMs: timing.fairnessAtMs ?? FAIRNESS_AT_MS, priority: 20 });
  for (let atMs = snapshotIntervalMs; atMs < durationMs; atMs += snapshotIntervalMs) {
    // Preserve the five-minute cadence even when an opt-in lifecycle action
    // at the same boundary needs most of its operation deadline.
    events.push({ kind: 'snapshot', atMs, priority: 15 });
  }
  for (const event of events) {
    if (!Number.isFinite(event.atMs) || event.atMs <= 0 || event.atMs >= durationMs) {
      throw new SoakPolicyError(`${event.kind} schedule must fall inside the soak duration`);
    }
  }
  events.sort((left, right) => left.atMs - right.atMs || left.priority - right.priority);
  events.push({ kind: 'final', atMs: durationMs, priority: 100 });
  return Object.freeze(events.map((event) => Object.freeze(event)));
}

function safeCode(value, fallback = 'SOAK_RUNTIME_FAILURE') {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function assertNoSecretMaterial(value, key = '') {
  if (/authorization|bearer|jwt|secret|token|raw|payload/i.test(key)) {
    throw new SoakPolicyError(`evidence field is forbidden: ${key}`, 'EVIDENCE_SECRET_FIELD');
  }
  if (typeof value === 'string') {
    if (/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(value) || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) {
      throw new SoakPolicyError('evidence value resembles a credential', 'EVIDENCE_SECRET_VALUE');
    }
    return;
  }
  if (value == null || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) assertNoSecretMaterial(child, childKey);
}

export function validateNewEvidencePath(evidencePath) {
  if (!path.isAbsolute(evidencePath)) throw new SoakPolicyError('evidence path must be absolute');
  const resolved = path.resolve(evidencePath);
  const parent = path.dirname(resolved);
  let parentReal;
  try { parentReal = realpathSync(parent); }
  catch { throw new SoakPolicyError('evidence parent directory is unavailable', 'EVIDENCE_PARENT_UNAVAILABLE'); }
  if (parentReal !== parent) {
    throw new SoakPolicyError('evidence parent or ancestor is symlinked', 'EVIDENCE_PARENT_SYMLINK');
  }
  try {
    lstatSync(resolved);
    throw new SoakPolicyError('evidence path already exists', 'EVIDENCE_EXISTS');
  } catch (error) {
    if (error instanceof SoakPolicyError) throw error;
    if (error?.code !== 'ENOENT') throw new SoakPolicyError('cannot inspect evidence path', 'EVIDENCE_PATH_UNSAFE');
  }
  return resolved;
}

export function openEvidenceFile(evidencePath) {
  const resolved = validateNewEvidencePath(evidencePath);
  const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL |
    (FS_CONSTANTS.O_NOFOLLOW ?? 0);
  let fd;
  try { fd = openSync(resolved, flags, 0o600); }
  catch { throw new SoakPolicyError('cannot create exclusive evidence file', 'EVIDENCE_CREATE_FAILED'); }
  try {
    fchmodSync(fd, 0o600);
    const details = fstatSync(fd);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 ||
        (details.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && details.uid !== process.getuid())) {
      throw new SoakPolicyError('evidence file identity or mode is unsafe', 'EVIDENCE_IDENTITY_UNSAFE');
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let closed = false;
  return Object.freeze({
    path: resolved,
    append(record) {
      if (closed) throw new SoakPolicyError('evidence writer is closed', 'EVIDENCE_CLOSED');
      assertNoSecretMaterial(record);
      writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  });
}

function processResult({ file, args, cwd, deadlineAt, maxBytes, capture, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      reject(new SoakPolicyError('fingerprint command deadline expired', 'FINGERPRINT_TIMEOUT'));
      return;
    }
    let child;
    try {
      child = spawnImpl(file, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      });
    } catch {
      reject(new SoakPolicyError('cannot start fingerprint command', 'FINGERPRINT_COMMAND_FAILED'));
      return;
    }
    const hash = createHash('sha256');
    const chunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish(new SoakPolicyError('fingerprint command timed out', 'FINGERPRINT_TIMEOUT'));
    }, remainingMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        finish(new SoakPolicyError('fingerprint command output exceeded its bound', 'FINGERPRINT_OUTPUT_LIMIT'));
        return;
      }
      hash.update(chunk);
      if (capture) chunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.once('error', () => finish(new SoakPolicyError('fingerprint command failed to start', 'FINGERPRINT_COMMAND_FAILED')));
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal != null) {
        finish(new SoakPolicyError(
          `fingerprint command failed (exit=${code ?? 'signal'}, stderrBytes=${stderrBytes})`,
          'FINGERPRINT_COMMAND_FAILED',
        ));
        return;
      }
      finish(null, {
        bytes,
        digest: hash.digest('hex'),
        ...(capture ? { buffer: Buffer.concat(chunks) } : {}),
      });
    });
  });
}

async function hashStableUntrackedFile(filePath, deadlineAt, total) {
  if (Date.now() >= deadlineAt) throw new SoakPolicyError('untracked hashing timed out', 'FINGERPRINT_TIMEOUT');
  const before = lstatSync(filePath, { bigint: true });
  if (before.isSymbolicLink()) {
    const target = readlinkSync(filePath);
    const after = lstatSync(filePath, { bigint: true });
    if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.mode !== after.mode) {
      throw new SoakPolicyError('untracked symlink changed while fingerprinting', 'FINGERPRINT_RACE');
    }
    return {
      kind: 'symlink',
      mode: Number(before.mode),
      bytes: Buffer.byteLength(target),
      digest: createHash('sha256').update(target).digest('hex'),
    };
  }
  if (!before.isFile()) throw new SoakPolicyError('unsupported untracked filesystem entry', 'FINGERPRINT_UNSUPPORTED_ENTRY');
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || total.bytes + size > 2 * 1024 * 1024 * 1024) {
    throw new SoakPolicyError('untracked content exceeds the 2 GiB fingerprint bound', 'FINGERPRINT_OUTPUT_LIMIT');
  }
  total.bytes += size;
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new SoakPolicyError('untracked hashing timed out', 'FINGERPRINT_TIMEOUT'));
    }, Math.max(1, deadlineAt - Date.now()));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', () => { clearTimeout(timer); reject(new SoakPolicyError('cannot hash untracked file', 'FINGERPRINT_READ_FAILED')); });
    stream.once('end', () => { clearTimeout(timer); resolve(); });
  });
  const after = lstatSync(filePath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.mode !== after.mode) {
    throw new SoakPolicyError('untracked file changed while fingerprinting', 'FINGERPRINT_RACE');
  }
  return { kind: 'file', mode: Number(before.mode), bytes: size, digest: hash.digest('hex') };
}

async function captureGitFrame(root, deadlineAt, spawnImpl) {
  const common = { cwd: root, deadlineAt, spawnImpl };
  const [head, headRef, status, stagedDiff, worktreeDiff, untracked] = await Promise.all([
    processResult({ file: '/usr/bin/git', args: ['rev-parse', '--verify', 'HEAD'], maxBytes: 4_096, capture: true, ...common }),
    processResult({ file: '/usr/bin/git', args: ['rev-parse', '--symbolic-full-name', 'HEAD'], maxBytes: 16_384, capture: true, ...common }),
    processResult({ file: '/usr/bin/git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], maxBytes: 32 * 1024 * 1024, capture: true, ...common }),
    processResult({ file: '/usr/bin/git', args: ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], maxBytes: 2 * 1024 * 1024 * 1024, capture: false, ...common }),
    processResult({ file: '/usr/bin/git', args: ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--'], maxBytes: 2 * 1024 * 1024 * 1024, capture: false, ...common }),
    processResult({ file: '/usr/bin/git', args: ['ls-files', '--others', '--exclude-standard', '-z'], maxBytes: 32 * 1024 * 1024, capture: true, ...common }),
  ]);
  return {
    head: head.buffer.toString('utf8').trim(),
    headRef: headRef.buffer.toString('utf8').trim(),
    status,
    stagedDiff,
    worktreeDiff,
    untracked,
  };
}

function untrackedPathsFromFrame(frame) {
  return frame.untracked.buffer.toString('utf8').split('\0').filter(Boolean).sort();
}

function assertSameGitFrame(first, second) {
  for (const field of ['head', 'headRef']) {
    if (first[field] !== second[field]) {
      throw new SoakPolicyError('Git HEAD changed while fingerprinting', 'FINGERPRINT_RACE');
    }
  }
  for (const field of ['status', 'stagedDiff', 'worktreeDiff', 'untracked']) {
    if (first[field].digest !== second[field].digest) {
      throw new SoakPolicyError('Git worktree changed while fingerprinting', 'FINGERPRINT_RACE');
    }
  }
}

async function hashUntrackedManifest(root, untrackedPaths, deadlineAt) {
  const hash = createHash('sha256');
  const total = { bytes: 0 };
  for (const relativePath of untrackedPaths) {
    const absolute = path.resolve(root, relativePath);
    const containment = path.relative(root, absolute);
    if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
      throw new SoakPolicyError('untracked path escapes Git root', 'FINGERPRINT_PATH_ESCAPE');
    }
    const entry = await hashStableUntrackedFile(absolute, deadlineAt, total);
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(String(entry.mode));
    hash.update('\0');
    hash.update(String(entry.bytes));
    hash.update('\0');
    hash.update(entry.digest);
    hash.update('\0');
  }
  return Object.freeze({ digest: hash.digest('hex'), bytes: total.bytes, count: untrackedPaths.length });
}

/**
 * Hash tracked diffs plus the bytes of every non-ignored untracked entry.
 * Raw diff, filenames, tool payloads, and credentials are never returned.
 */
export async function captureGitDirtyFingerprint(projectPath, runtime = {}) {
  const deadlineAt = runtime.deadlineAt ?? Date.now() + 120_000;
  let canonicalProject;
  try { canonicalProject = realpathSync(projectPath); }
  catch { throw new SoakPolicyError('project path is unavailable', 'FINGERPRINT_PROJECT_UNAVAILABLE'); }
  if (canonicalProject !== path.resolve(projectPath)) {
    throw new SoakPolicyError('project path is not exact canonical identity', 'FINGERPRINT_PROJECT_NOT_CANONICAL');
  }
  const rootResult = await processResult({
    file: '/usr/bin/git',
    args: ['rev-parse', '--show-toplevel'],
    cwd: canonicalProject,
    deadlineAt,
    maxBytes: 16 * 1024,
    capture: true,
    spawnImpl: runtime.spawnImpl,
  });
  const rootText = rootResult.buffer.toString('utf8').trim();
  let root;
  try { root = realpathSync(rootText); }
  catch { throw new SoakPolicyError('Git root is unavailable', 'FINGERPRINT_GIT_ROOT_UNAVAILABLE'); }
  const projectRelative = path.relative(root, canonicalProject);
  if (projectRelative === '..' || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) {
    throw new SoakPolicyError('project is outside its Git root', 'FINGERPRINT_GIT_ROOT_MISMATCH');
  }

  const stagedEntries = await processResult({
    file: '/usr/bin/git',
    args: ['ls-files', '--stage', '-z'],
    cwd: root,
    deadlineAt,
    maxBytes: 64 * 1024 * 1024,
    capture: true,
    spawnImpl: runtime.spawnImpl,
  });
  if (stagedEntries.buffer.toString('utf8').split('\0').some((entry) => entry.startsWith('160000 '))) {
    // A parent status line cannot fingerprint uncommitted bytes inside a
    // submodule. Refuse a weak baseline instead of silently missing them.
    throw new SoakPolicyError('Git submodules require a separate recursive fingerprint', 'FINGERPRINT_SUBMODULE_UNSUPPORTED');
  }

  const first = await captureGitFrame(root, deadlineAt, runtime.spawnImpl);
  const untrackedPaths = untrackedPathsFromFrame(first);
  const firstUntracked = await hashUntrackedManifest(root, untrackedPaths, deadlineAt);
  await runtime.fingerprintCheckpoint?.('after-first-untracked-manifest');
  const second = await captureGitFrame(root, deadlineAt, runtime.spawnImpl);
  assertSameGitFrame(first, second);
  const secondUntracked = await hashUntrackedManifest(root, untrackedPathsFromFrame(second), deadlineAt);
  if (firstUntracked.digest !== secondUntracked.digest || firstUntracked.bytes !== secondUntracked.bytes ||
      firstUntracked.count !== secondUntracked.count) {
    throw new SoakPolicyError('untracked manifest changed while fingerprinting', 'FINGERPRINT_RACE');
  }
  const digest = createHash('sha256')
    .update('unity-mcp-router-dirty-v1\0')
    .update(first.head).update('\0')
    .update(first.headRef).update('\0')
    .update(first.status.digest).update('\0')
    .update(first.stagedDiff.digest).update('\0')
    .update(first.worktreeDiff.digest).update('\0')
    .update(first.untracked.digest).update('\0')
    .update(firstUntracked.digest).digest('hex');
  return Object.freeze({
    algorithm: 'unity-mcp-router-dirty-v1',
    digest,
    head: first.head,
    headRef: first.headRef,
    dirty: first.status.bytes > 0,
    statusBytes: first.status.bytes,
    untrackedCount: firstUntracked.count,
    untrackedBytes: firstUntracked.bytes,
    projectPath: canonicalProject,
    gitRoot: root,
  });
}

export function assertFingerprintStable(before, after) {
  if (!before || !after || before.algorithm !== after.algorithm || before.digest !== after.digest ||
      before.head !== after.head || before.headRef !== after.headRef ||
      before.projectPath !== after.projectPath || before.gitRoot !== after.gitRoot) {
    throw new SoakPolicyError('dirty Unity worktree fingerprint changed during soak', 'DIRTY_FINGERPRINT_CHANGED');
  }
  return true;
}

class SoakStdioClient {
  constructor({ adapter, project, maxOutputBytes, name, now = Date.now, spawnImpl = spawn }) {
    this.name = name;
    this.maxOutputBytes = maxOutputBytes;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.closed = false;
    this.failure = null;
    this.now = now;
    this.decoder = new JsonRpcLineDecoder({ maxLineBytes: maxOutputBytes });
    this.proc = spawnImpl(adapter, ['--default', project], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stdout.on('end', () => {
      try { this.decoder.end(); }
      catch { this.#fail(new SoakPolicyError(`${this.name} ended with invalid framing`, 'ADAPTER_FRAMING_ERROR')); }
    });
    this.proc.stderr.on('data', (chunk) => this.#onStderr(chunk));
    this.exit = new Promise((resolve) => this.proc.once('close', (code, signal) => {
      if (!this.closed && (code !== 0 || signal != null)) this.#fail(new Error(`${name} adapter exited`));
      resolve({ code, signal });
    }));
    this.proc.once('error', (error) => this.#fail(error));
  }

  #onStdout(chunk) {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.maxOutputBytes) {
      this.#fail(new SoakPolicyError(`${this.name} stdout exceeded its bound`, 'ADAPTER_OUTPUT_LIMIT'));
      this.proc.kill('SIGKILL');
      return;
    }
    let messages;
    try { messages = this.decoder.push(chunk); }
    catch {
      this.#fail(new SoakPolicyError(`${this.name} emitted invalid framing`, 'ADAPTER_FRAMING_ERROR'));
      this.proc.kill('SIGKILL');
      return;
    }
    for (const message of messages) {
      const key = `${typeof message.id}:${String(message.id)}`;
      const pending = this.pending.get(key);
      if (message.id != null && pending) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else if (message.id == null && typeof message.method === 'string') {
        // Deliberately discard notification params: evidence needs only method counts.
        this.notifications.push(Object.freeze({ method: message.method }));
      } else this.#fail(new SoakPolicyError(`${this.name} received an unmatched response`, 'ADAPTER_PROTOCOL_ERROR'));
    }
  }

  #onStderr(chunk) {
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > this.maxOutputBytes) {
      this.#fail(new SoakPolicyError(`${this.name} stderr exceeded its bound`, 'ADAPTER_OUTPUT_LIMIT'));
      this.proc.kill('SIGKILL');
    }
  }

  #fail(error) {
    this.failure ??= error;
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  request(method, params = {}, { deadlineAt } = {}) {
    if (this.closed) return Promise.reject(new SoakPolicyError(`${this.name} is closed`, 'ADAPTER_CLOSED'));
    if (this.failure) return Promise.reject(this.failure);
    const remainingMs = deadlineAt - this.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return Promise.reject(new SoakPolicyError(`${method} deadline expired`, 'REQUEST_DEADLINE_EXCEEDED'));
    }
    const id = this.nextId++;
    const key = `number:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        try {
          this.proc.stdin.write(encodeJsonRpcLine({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'live-soak absolute request deadline' },
          }));
        } catch { /* adapter may be gone */ }
        reject(new SoakPolicyError(`${method} exceeded its absolute deadline`, 'REQUEST_DEADLINE_EXCEEDED'));
      }, remainingMs);
      this.pending.set(key, { resolve, reject, timer });
      this.proc.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (error && this.pending.delete(key)) {
          clearTimeout(timer);
          reject(new SoakPolicyError(`${method} could not be dispatched`, 'ADAPTER_WRITE_FAILED'));
        }
      });
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.proc.stdin.write(encodeJsonRpcLine({ jsonrpc: '2.0', method, params }));
  }

  async initialize(deadlineAt) {
    const response = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.name, version: '1' },
    }, { deadlineAt });
    if (response?.result?.protocolVersion !== MCP_PROTOCOL_VERSION ||
        response?.result?.capabilities?.tools?.listChanged !== true) {
      throw new SoakPolicyError('adapter initialization contract drifted', 'INITIALIZE_CONTRACT_DRIFT');
    }
    this.notify('notifications/initialized', {});
    return response;
  }

  async close({ requireGraceful = false } = {}) {
    if (this.closed) return this.exit;
    this.closed = true;
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(new SoakPolicyError(`${this.name} closed`, 'ADAPTER_CLOSED'));
    }
    if (this.proc.exitCode != null || this.proc.signalCode != null) {
      const outcome = await this.exit;
      if (requireGraceful && this.failure) throw this.failure;
      if (requireGraceful && (outcome.code !== 0 || outcome.signal != null)) {
        throw new SoakPolicyError(`${this.name} did not close gracefully`, 'ADAPTER_CLOSE_NOT_GRACEFUL');
      }
      return outcome;
    }
    this.proc.stdin.end();
    let outcome = await Promise.race([this.exit, new Promise((resolve) => setTimeout(resolve, 5_000, null))]);
    if (outcome) {
      if (requireGraceful && this.failure) throw this.failure;
      if (requireGraceful && (outcome.code !== 0 || outcome.signal != null)) {
        throw new SoakPolicyError(`${this.name} did not close gracefully`, 'ADAPTER_CLOSE_NOT_GRACEFUL');
      }
      return outcome;
    }
    this.proc.kill('SIGTERM');
    outcome = await Promise.race([this.exit, new Promise((resolve) => setTimeout(resolve, 2_000, null))]);
    if (!outcome) {
      this.proc.kill('SIGKILL');
      outcome = await this.exit;
    }
    if (requireGraceful) throw new SoakPolicyError(`${this.name} required forced termination`, 'ADAPTER_CLOSE_NOT_GRACEFUL');
    return outcome;
  }
}

function responseCode(response) {
  return safeCode(
    response?.result?.structuredContent?.code ??
    response?.error?.data?.brokerCode ??
    response?.error?.data?.code,
    'TOOL_CALL_FAILED',
  );
}

function structuredResponse(response, label) {
  if (response?.error || response?.result?.isError === true) {
    throw new SoakPolicyError(`${label} failed`, responseCode(response));
  }
  const value = response?.result?.structuredContent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SoakPolicyError(`${label} omitted structuredContent`, 'STRUCTURED_CONTENT_MISSING');
  }
  return value;
}

function hashCatalog(catalog) {
  return createHash('sha256').update(catalog).digest('hex');
}

function callDeadline(state, operation = false, absoluteDeadlineAt = Number.POSITIVE_INFINITY) {
  const local = state.clock.now() + (operation ? state.operationTimeoutMs : state.requestTimeoutMs);
  return Math.min(local, state.overallDeadlineAt, absoluteDeadlineAt);
}

async function request(
  state,
  client,
  method,
  params = {},
  operation = false,
  absoluteDeadlineAt = Number.POSITIVE_INFINITY,
) {
  const deadlineAt = callDeadline(state, operation, absoluteDeadlineAt);
  if (deadlineAt <= state.clock.now()) {
    throw new SoakPolicyError(`${method} absolute deadline expired`, 'REQUEST_DEADLINE_EXCEEDED');
  }
  const response = await client.request(method, params, { deadlineAt });
  if (state.clock.now() > deadlineAt) {
    throw new SoakPolicyError(`${method} exceeded its absolute deadline`, 'REQUEST_DEADLINE_EXCEEDED');
  }
  return response;
}

async function callTool(
  state,
  client,
  name,
  argumentsValue = {},
  operation = false,
  absoluteDeadlineAt = Number.POSITIVE_INFINITY,
) {
  return request(
    state,
    client,
    'tools/call',
    { name, arguments: argumentsValue },
    operation,
    absoluteDeadlineAt,
  );
}

async function sleepWithinDeadline(state, ms, deadlineAt, code = 'ACTION_DEADLINE_EXCEEDED') {
  if (!Number.isFinite(ms) || ms < 0 || state.clock.now() + ms > deadlineAt) {
    throw new SoakPolicyError('action cannot complete inside its absolute deadline', code);
  }
  await state.clock.sleep(ms);
  if (state.clock.now() > deadlineAt) {
    throw new SoakPolicyError('action exceeded its absolute deadline', code);
  }
}

function assertExactSingleEditor(audit, expectedProjectPath, label, expectedPid = null) {
  if (audit?.ok !== true || !Array.isArray(audit?.editors) || audit.editors.length !== 1) {
    throw new SoakPolicyError(`${label} must report exactly one healthy Editor`, 'EDITOR_COUNT_DRIFT');
  }
  const editor = audit.editors[0];
  if (!Number.isSafeInteger(editor?.pid) || editor.projectPath !== expectedProjectPath) {
    throw new SoakPolicyError(`${label} Editor identity drifted`, 'EDITOR_IDENTITY_DRIFT');
  }
  if (expectedPid != null && editor.pid !== expectedPid) {
    throw new SoakPolicyError(`${label} Editor PID drifted`, 'EDITOR_IDENTITY_DRIFT');
  }
  return editor;
}

function projectChildIdentities(snapshot) {
  return (snapshot?.projects ?? []).map((entry) => ({
    name: entry.name,
    path: entry.path,
    pid: entry.child?.pid ?? null,
    alive: entry.child?.alive === true,
    ready: entry.child?.ready === true,
    state: entry.child?.state ?? null,
    toolsFingerprint: entry.tools ?? null,
  })).sort((left, right) => left.path.localeCompare(right.path));
}

export function assertBaselineProjectChildren(snapshot, project) {
  const target = selectedProject(snapshot, project);
  if (target.child?.state !== 'READY' || target.child?.alive !== true ||
      target.child?.ready !== true || !Number.isSafeInteger(target.child?.pid)) {
    throw new SoakPolicyError(
      'target configured project child must be READY at baseline',
      'TARGET_CHILD_NOT_READY_AT_BASELINE',
    );
  }
  const activeNonTargets = (snapshot?.projects ?? []).filter((entry) => entry !== target && (
    entry.child?.state !== 'OFFLINE' || entry.child?.pid != null ||
    entry.child?.alive === true || entry.child?.ready === true
  ));
  if (activeNonTargets.length > 0) {
    const names = activeNonTargets.map((entry) => entry.name ?? entry.path ?? 'unnamed').join(', ');
    throw new SoakPolicyError(
      `non-target configured project children must be OFFLINE at baseline: ${names}`,
      'NON_TARGET_CHILD_ACTIVE_AT_BASELINE',
    );
  }
  return target;
}

function assertProjectChildIdentities(snapshot, expected, { allowChangedPath = null } = {}) {
  const observed = projectChildIdentities(snapshot);
  if (!Array.isArray(expected) || observed.length !== expected.length) {
    throw new SoakPolicyError('configured project child set drifted', 'PROJECT_CHILD_SET_DRIFT');
  }
  let allowedChanged = false;
  for (let index = 0; index < expected.length; index += 1) {
    const before = expected[index];
    const after = observed[index];
    if (before.path !== after.path || before.name !== after.name) {
      throw new SoakPolicyError('configured project child identity drifted', 'PROJECT_CHILD_SET_DRIFT');
    }
    if (before.alive !== after.alive || before.ready !== after.ready || before.state !== after.state ||
        before.toolsFingerprint !== after.toolsFingerprint) {
      throw new SoakPolicyError('configured project child state or catalog drifted', 'PROJECT_CHILD_STATE_DRIFT');
    }
    if (before.pid === after.pid) continue;
    if (after.path !== allowChangedPath || allowedChanged || !Number.isSafeInteger(after.pid)) {
      throw new SoakPolicyError('non-target project child PID drifted', 'PROJECT_CHILD_PID_DRIFT');
    }
    allowedChanged = true;
  }
  return { observed, allowedChanged };
}

export function assertRouterSnapshot(snapshot, {
  project,
  projectPath,
  brokerPid,
  childPid,
  buildId,
  configHash,
  toolsFingerprint,
  editorPid,
  projectChildren,
  expectedClients = 2,
}) {
  const target = selectedProject(snapshot, project);
  const failures = [];
  if (target.path !== projectPath) failures.push('project route path drifted');
  if (snapshot?.broker?.pid !== brokerPid) failures.push('broker PID drifted');
  if (snapshot?.broker?.buildId !== buildId) failures.push('broker buildId drifted');
  if (snapshot?.broker?.configHash !== configHash) failures.push('broker configHash drifted');
  if (snapshot?.broker?.clients !== expectedClients) failures.push('broker client count drifted');
  if (snapshot?.broker?.draining !== false) failures.push('broker is draining');
  if (target.child?.pid !== childPid || target.child?.alive !== true || target.child?.ready !== true) failures.push('project child identity drifted');
  if (target.tools !== toolsFingerprint) failures.push('project catalog fingerprint drifted');
  if (snapshot?.budget?.pendingTotal !== 0 || snapshot?.budget?.activeHeavy !== 0) failures.push('global queue is not idle');
  if (!Array.isArray(snapshot?.leases) || snapshot.leases.length !== 0) failures.push('lease remains');
  if (!Array.isArray(snapshot?.workspaceLeases) || snapshot.workspaceLeases.length !== 0) failures.push('workspace lease remains');
  if (snapshot?.workspaceStore?.ok !== true) failures.push('workspace store is unhealthy');
  if (!Array.isArray(snapshot?.unknownOutcomes) || snapshot.unknownOutcomes.length !== 0) failures.push('unknown outcome remains');
  if (!Array.isArray(snapshot?.recoveryFaults) || snapshot.recoveryFaults.length !== 0) failures.push('recovery fault remains');
  if (snapshot?.processAudit?.ok !== true || snapshot?.projectAccess?.ok !== true) failures.push('audit failed');
  for (const entry of snapshot?.projects ?? []) {
    if (entry.scheduler && (
      entry.scheduler.pending !== 0 || entry.scheduler.queued !== 0 ||
      entry.scheduler.activeOperationId !== null || entry.scheduler.activeClientId !== null
    )) failures.push(`scheduler not idle for ${entry.name}`);
    if ((entry.mutationFence?.length ?? 0) !== 0) failures.push(`mutation fence remains for ${entry.name}`);
    if (entry.backgroundOperation != null) failures.push(`background operation remains for ${entry.name}`);
    if ((entry.deliveryPending?.length ?? 0) !== 0) failures.push(`delivery pending remains for ${entry.name}`);
  }
  const livePids = (snapshot?.projects ?? []).map((entry) => entry.child?.pid).filter(Number.isSafeInteger);
  if (new Set(livePids).size !== livePids.length) failures.push('project child PID is duplicated');
  if (failures.length > 0) throw new SoakPolicyError(failures.join('; '), 'SNAPSHOT_INVARIANT_FAILED');
  assertExactSingleEditor(snapshot.processAudit, projectPath, 'status process audit', editorPid);
  assertProjectChildIdentities(snapshot, projectChildren);
  return target;
}

export function assertNotificationAllowlist(methods, allowlist = NOTIFICATION_ALLOWLIST) {
  for (const method of methods) {
    if (typeof method !== 'string' || !allowlist.has(method)) {
      throw new SoakPolicyError('received a forbidden notification method', 'FORBIDDEN_NOTIFICATION');
    }
  }
  return true;
}

export function assertScheduleDrift(kind, dueAt, observedAt, maximumDriftMs) {
  const driftMs = Math.max(0, observedAt - dueAt);
  if (!Number.isFinite(maximumDriftMs) || maximumDriftMs < 0 || driftMs > maximumDriftMs) {
    throw new SoakPolicyError(`${kind} missed its periodic dispatch window`, 'PERIODIC_DISPATCH_MISSED');
  }
  return driftMs;
}

function registerClient(state, client, logical) {
  state.notificationCursors.set(client, 0);
  state.clientLogical.set(client, logical);
}

function harvestNotifications(state, client) {
  const cursor = state.notificationCursors.get(client) ?? 0;
  const messages = (client.notifications ?? []).slice(cursor);
  const methods = messages.map((message) => message?.method);
  assertNotificationAllowlist(methods);
  const logical = state.clientLogical.get(client);
  for (const method of methods) {
    state.notificationTotals[logical][method] = (state.notificationTotals[logical][method] ?? 0) + 1;
  }
  state.notificationCursors.set(client, cursor + messages.length);
  return methods;
}

function harvestCurrentNotifications(state) {
  harvestNotifications(state, state.current.codex);
  harvestNotifications(state, state.current.claude);
}

function assertNotificationTotals(state) {
  harvestCurrentNotifications(state);
  for (const logical of ['codex', 'claude']) {
    const observed = state.notificationTotals[logical]['notifications/tools/list_changed'] ?? 0;
    if (observed !== state.expectedListChanged[logical]) {
      throw new SoakPolicyError(
        `${logical} list_changed count drifted (${observed} != ${state.expectedListChanged[logical]})`,
        'LIST_CHANGED_COUNT_DRIFT',
      );
    }
  }
}

function record(state, type, details = {}) {
  state.evidence.append({
    type,
    at: new Date(state.clock.now()).toISOString(),
    elapsedSec: Number(((state.clock.now() - state.startedAt) / 1_000).toFixed(3)),
    ...details,
  });
}

async function exactCatalog(state, client, deadlineAt = Number.POSITIVE_INFINITY) {
  const response = await request(state, client, 'tools/list', {}, false, deadlineAt);
  const canonical = canonicalToolCatalog(response);
  if (canonical !== state.catalog) {
    throw new SoakPolicyError('tool catalog changed', 'CATALOG_DRIFT');
  }
  return response;
}

async function waitForCatalog(state, client, deadlineAt) {
  for (;;) {
    const response = await request(state, client, 'tools/list', {}, false, deadlineAt);
    if (response?.error?.data?.brokerCode !== 'TOOL_CATALOG_RECOVERING') {
      const canonical = canonicalToolCatalog(response);
      if (canonical === state.catalog) return response;
    }
    if (state.clock.now() >= deadlineAt) {
      throw new SoakPolicyError('tool catalog did not recover before the action deadline', 'CATALOG_RECOVERY_TIMEOUT');
    }
    await sleepWithinDeadline(state, Math.min(200, deadlineAt - state.clock.now()), deadlineAt, 'CATALOG_RECOVERY_TIMEOUT');
  }
}

async function statusSnapshot(
  state,
  client = state.current.codex,
  deadlineAt = Number.POSITIVE_INFINITY,
) {
  const snapshot = structuredResponse(
    await callTool(state, client, 'unity_router_status', {}, false, deadlineAt),
    'unity_router_status',
  );
  return { snapshot, target: selectedProject(snapshot, state.options.project) };
}

function identityFromStatus(state, snapshot) {
  const target = assertRouterSnapshot(snapshot, {
    project: state.options.project,
    projectPath: state.options.projectPath,
    brokerPid: state.identity.brokerPid,
    childPid: state.identity.childPid,
    buildId: state.identity.buildId,
    configHash: state.identity.configHash,
    toolsFingerprint: state.identity.toolsFingerprint,
    editorPid: state.identity.editorPid,
    projectChildren: state.identity.projectChildren,
  });
  return target;
}

function summarizeSnapshot(state, snapshot, target) {
  const editor = snapshot.processAudit.editors[0];
  return {
    broker: {
      pid: snapshot.broker.pid,
      buildId: snapshot.broker.buildId,
      configHash: snapshot.broker.configHash,
      draining: snapshot.broker.draining,
      clients: snapshot.broker.clients,
    },
    project: {
      name: target.name,
      path: target.path,
      childPid: target.child.pid,
      childState: target.child.state,
      childReady: target.child.ready,
      catalogFingerprint: target.tools,
      schedulerPending: target.scheduler?.pending ?? null,
      schedulerQueued: target.scheduler?.queued ?? null,
      backgroundOperation: target.backgroundOperation != null,
      mutationFenceCount: target.mutationFence?.length ?? 0,
      deliveryPendingCount: target.deliveryPending?.length ?? 0,
    },
    projectChildren: projectChildIdentities(snapshot),
    global: {
      pendingTotal: snapshot.budget.pendingTotal,
      activeHeavy: snapshot.budget.activeHeavy,
      leaseCount: snapshot.leases.length,
      workspaceLeaseCount: snapshot.workspaceLeases.length,
      unknownOutcomeCount: snapshot.unknownOutcomes.length,
      recoveryFaultCount: snapshot.recoveryFaults.length,
    },
    audit: {
      processOk: snapshot.processAudit.ok,
      projectAccessOk: snapshot.projectAccess.ok,
      editorCount: snapshot.processAudit.editors.length,
      editorPid: editor.pid,
      editorProjectPath: editor.projectPath,
    },
    notificationCounts: {
      codexListChanged: state.notificationTotals.codex['notifications/tools/list_changed'] ?? 0,
      claudeListChanged: state.notificationTotals.claude['notifications/tools/list_changed'] ?? 0,
    },
  };
}

async function takeSnapshot(
  state,
  label,
  { doctor = false, deadlineAt = Number.POSITIVE_INFINITY, dispatchDriftMs = 0 } = {},
) {
  await Promise.all([
    exactCatalog(state, state.current.codex, deadlineAt),
    exactCatalog(state, state.current.claude, deadlineAt),
  ]);
  assertNotificationTotals(state);
  const { snapshot } = await statusSnapshot(state, state.current.codex, deadlineAt);
  const target = identityFromStatus(state, snapshot);
  if (doctor) {
    const audit = structuredResponse(
      await callTool(state, state.current.claude, 'unity_router_doctor', {}, false, deadlineAt),
      'unity_router_doctor',
    );
    assertCleanRouterState(snapshot, audit, state.options.project);
    assertExactSingleEditor(audit, state.options.projectPath, 'doctor', state.identity.editorPid);
  }
  const summary = summarizeSnapshot(state, snapshot, target);
  record(state, 'snapshot', { label, dispatchDriftMs, ...summary });
  return { snapshot, target, summary };
}

async function simultaneousSafeRead(state, label, scheduledAt = null) {
  const dispatchedAt = state.clock.now();
  const codexRequest = callTool(state, state.current.codex, 'editor_status');
  const claudeRequest = callTool(state, state.current.claude, 'editor_status');
  const [codexResponse, claudeResponse] = await Promise.all([codexRequest, claudeRequest]);
  const codex = assertEditorReady(editorObservation(codexResponse), state.options.projectPath);
  const claude = assertEditorReady(editorObservation(claudeResponse), state.options.projectPath);
  if (codex.projectPath !== claude.projectPath || codex.unityVersion !== claude.unityVersion) {
    throw new SoakPolicyError('Codex and Claude safe reads disagree on Editor identity', 'CROSS_CLIENT_ROUTE_DRIFT');
  }
  if (typeof codex.unityVersion !== 'string' || codex.unityVersion.length === 0) {
    throw new SoakPolicyError('Editor version identity is missing', 'EDITOR_IDENTITY_DRIFT');
  }
  if (state.editorUnityVersion == null) state.editorUnityVersion = codex.unityVersion;
  else if (codex.unityVersion !== state.editorUnityVersion) {
    throw new SoakPolicyError('Editor version identity drifted', 'EDITOR_IDENTITY_DRIFT');
  }
  state.safeReadRounds += 1;
  record(state, 'safe_read_round', {
    label,
    simultaneousDispatch: true,
    dispatchDriftMs: scheduledAt == null ? 0 : Math.max(0, dispatchedAt - scheduledAt),
    dispatchedAtElapsedSec: Number(((dispatchedAt - state.startedAt) / 1_000).toFixed(3)),
    projectPath: codex.projectPath,
    unityVersion: codex.unityVersion,
    codexStatus: codex.status,
    claudeStatus: claude.status,
  });
  return { codex, claude };
}

async function waitForReloadTerminal(state, initial, deadlineAt) {
  let observation = recompileObservation(initial);
  assertCleanActiveRecompile(observation);
  for (;;) {
    if (state.clock.now() >= deadlineAt) {
      throw new SoakPolicyError('reload terminal status timed out', 'RELOAD_STATUS_TIMEOUT');
    }
    await sleepWithinDeadline(
      state,
      Math.min(250, deadlineAt - state.clock.now()),
      deadlineAt,
      'RELOAD_STATUS_TIMEOUT',
    );
    observation = recompileObservation(await callTool(
      state,
      state.current.codex,
      'recompile_status',
      {},
      false,
      deadlineAt,
    ));
    if (observation.status === 'completed') return observation;
    assertCleanActiveRecompile(observation);
  }
}

async function waitForReloadJournal(state, operationId, deadlineAt, requireStatusTool) {
  for (;;) {
    const operation = structuredResponse(await callTool(
      state,
      state.current.codex,
      'unity_router_operation_status',
      { operationId },
      false,
      deadlineAt,
    ), 'unity_router_operation_status');
    if (operation.state === 'COMPLETED') {
      return assertCompletedReloadOperation(operation, operationId, { requireStatusTool });
    }
    const transient = requireStatusTool ? ['RUNNING'] : ['RECEIVED', 'QUEUED', 'DISPATCHING'];
    if (!transient.includes(operation.state)) {
      throw new SoakPolicyError('reload journal reached a disallowed state', 'RELOAD_JOURNAL_DRIFT');
    }
    if (state.clock.now() >= deadlineAt) {
      throw new SoakPolicyError('reload journal completion timed out', 'RELOAD_JOURNAL_TIMEOUT');
    }
    await sleepWithinDeadline(
      state,
      Math.min(250, deadlineAt - state.clock.now()),
      deadlineAt,
      'RELOAD_JOURNAL_TIMEOUT',
    );
  }
}

async function requireListChangedDelta(state, before, reason, expectedDelta, deadlineAt) {
  await sleepWithinDeadline(state, state.options.settleMs, deadlineAt, 'NOTIFICATION_SETTLE_TIMEOUT');
  harvestCurrentNotifications(state);
  for (const logical of ['codex', 'claude']) {
    const after = state.notificationTotals[logical]['notifications/tools/list_changed'] ?? 0;
    if (after - before[logical] !== expectedDelta) {
      throw new SoakPolicyError(
        `${reason} must emit exactly ${expectedDelta} list_changed notifications to ${logical}`,
        'LIST_CHANGED_COUNT_DRIFT',
      );
    }
    state.expectedListChanged[logical] += expectedDelta;
  }
  assertNotificationTotals(state);
}

function listChangedBaseline(state) {
  harvestCurrentNotifications(state);
  return Object.fromEntries(['codex', 'claude'].map((logical) => [
    logical,
    state.notificationTotals[logical]['notifications/tools/list_changed'] ?? 0,
  ]));
}

async function performReload(state) {
  const before = listChangedBaseline(state);
  const deadlineAt = Math.min(state.overallDeadlineAt, state.clock.now() + state.operationTimeoutMs);
  state.dispatches.reload += 1;
  if (state.dispatches.reload !== 1) throw new SoakPolicyError('reload dispatch count exceeded one', 'MUTATION_RETRY_FORBIDDEN');
  record(state, 'operation_start', { operation: 'reload', dispatchCount: 1, mutationRetryCount: 0 });
  const initial = await callTool(
    state,
    state.current.codex,
    'recompile',
    { focus: false, force: true },
    true,
    deadlineAt,
  );
  const dispatch = classifyReloadDispatch(initial);
  const terminal = dispatch.kind === 'async'
    ? await waitForReloadTerminal(state, initial, deadlineAt)
    : dispatch.observation;
  assertCleanTerminal(terminal, 'reload');
  await waitForReloadJournal(state, dispatch.operationId, deadlineAt, dispatch.requireStatusTool);
  await Promise.all([
    waitForCatalog(state, state.current.codex, deadlineAt),
    waitForCatalog(state, state.current.claude, deadlineAt),
  ]);
  await requireListChangedDelta(state, before, 'reload', 1, deadlineAt);
  const { snapshot } = await statusSnapshot(state, state.current.codex, deadlineAt);
  identityFromStatus(state, snapshot);
  record(state, 'operation_complete', {
    operation: 'reload',
    dispatchCount: 1,
    mutationRetryCount: 0,
    operationId: dispatch.operationId,
    completionPath: dispatch.kind,
  });
}

async function performReconnect(state) {
  const prior = state.current.claude;
  harvestNotifications(state, prior);
  record(state, 'reconnect_start', { client: 'claude', graceful: true });
  await prior.close({ requireGraceful: true });
  // close waits for stdout to drain; harvest again so a notification arriving
  // between the first harvest and EOF cannot escape allowlist/count checks.
  harvestNotifications(state, prior);
  assertNotificationTotals(state);
  await assertEditorReady(
    editorObservation(await callTool(state, state.current.codex, 'editor_status')),
    state.options.projectPath,
  );
  const replacement = state.makeClient(CLIENT_NAMES.claude);
  state.allClients.push(replacement);
  state.current.claude = replacement;
  registerClient(state, replacement, 'claude');
  await replacement.initialize(callDeadline(state));
  const listed = await request(state, replacement, 'tools/list', {});
  if (canonicalToolCatalog(listed) !== state.catalog) {
    throw new SoakPolicyError('reconnected Claude catalog drifted', 'CATALOG_DRIFT');
  }
  assertEditorReady(editorObservation(await callTool(state, replacement, 'editor_status')), state.options.projectPath);
  const { snapshot } = await statusSnapshot(state);
  identityFromStatus(state, snapshot);
  assertNotificationTotals(state);
  state.reconnects += 1;
  if (state.reconnects !== 1) throw new SoakPolicyError('reconnect count drifted', 'RECONNECT_COUNT_DRIFT');
  record(state, 'reconnect_complete', { client: 'claude', graceful: true, reconnectCount: 1 });
}

function resolveAdminRestartCommand(adapter) {
  const prefix = path.dirname(path.dirname(adapter));
  const current = path.join(prefix, 'current');
  let deployment;
  try { deployment = realpathSync(current); }
  catch { throw new SoakPolicyError('cannot resolve installed deployment for restart', 'ADMIN_RESTART_UNAVAILABLE'); }
  if (path.dirname(deployment) !== path.join(prefix, 'deployments') || !/^d-[a-f0-9]+$/i.test(path.basename(deployment))) {
    throw new SoakPolicyError('installed deployment identity is unsafe', 'ADMIN_RESTART_UNAVAILABLE');
  }
  const oneLine = (name) => {
    const value = readFileSync(path.join(deployment, name), 'utf8').trim();
    if (!value || value.includes('\n') || value.includes('/') && name === 'release-id.txt') {
      throw new SoakPolicyError(`invalid ${name} metadata`, 'ADMIN_RESTART_UNAVAILABLE');
    }
    return value;
  };
  const nodeBin = oneLine('node-bin.txt');
  const releaseId = oneLine('release-id.txt');
  const routerCli = path.join(prefix, 'releases', releaseId, 'router-cli.mjs');
  const config = path.join(deployment, 'config.json');
  for (const file of [nodeBin, routerCli, config]) {
    const details = statSync(file);
    if (!details.isFile()) throw new SoakPolicyError('admin restart dependency is not a file', 'ADMIN_RESTART_UNAVAILABLE');
  }
  return Object.freeze({ prefix, deployment, nodeBin, routerCli, config });
}

async function defaultAdminRestart({
  project,
  adapter,
  deadlineAt,
  now = Date.now,
  command = resolveAdminRestartCommand(adapter),
}) {
  if (realpathSync(path.join(command.prefix, 'current')) !== command.deployment) {
    throw new SoakPolicyError('deployment changed before controlled restart', 'DEPLOYMENT_DRIFT');
  }
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) throw new SoakPolicyError('controlled restart deadline expired', 'ADMIN_RESTART_TIMEOUT');
  await new Promise((resolve, reject) => {
    const child = spawn(command.nodeBin, [
      command.routerCli,
      '--config', command.config,
      '--broker-mode', 'connect-only',
      '--default', project,
      '--project', project,
      'restart',
    ], {
      cwd: command.deployment,
      env: process.env,
      stdio: 'ignore',
    });
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let hardTimer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 1_000);
      hardTimer = setTimeout(() => finish(new SoakPolicyError(
        'controlled restart exceeded its absolute deadline',
        'ADMIN_RESTART_TIMEOUT',
      )), 3_000);
    }, remainingMs);
    child.once('error', () => finish(new SoakPolicyError('controlled restart could not start', 'ADMIN_RESTART_FAILED')));
    child.once('close', (code, signal) => finish(timedOut
      ? new SoakPolicyError('controlled restart exceeded its absolute deadline', 'ADMIN_RESTART_TIMEOUT')
      : (code === 0 && signal == null
          ? null
          : new SoakPolicyError('controlled restart failed', 'ADMIN_RESTART_FAILED'))));
  });
  if (realpathSync(path.join(command.prefix, 'current')) !== command.deployment) {
    throw new SoakPolicyError('deployment changed during controlled restart', 'DEPLOYMENT_DRIFT');
  }
}

async function performRestart(state) {
  const before = listChangedBaseline(state);
  const priorChildPid = state.identity.childPid;
  const deadlineAt = Math.min(state.overallDeadlineAt, state.clock.now() + state.operationTimeoutMs);
  state.dispatches.restart += 1;
  if (state.dispatches.restart !== 1) throw new SoakPolicyError('restart dispatch count exceeded one', 'MUTATION_RETRY_FORBIDDEN');
  record(state, 'operation_start', { operation: 'controlled_child_restart', dispatchCount: 1, mutationRetryCount: 0 });
  await state.adminRestart({
    project: state.options.project,
    adapter: state.options.adapter,
    deadlineAt,
    now: state.clock.now,
  });
  if (state.clock.now() > deadlineAt) {
    throw new SoakPolicyError('controlled restart exceeded its absolute deadline', 'ADMIN_RESTART_TIMEOUT');
  }
  await Promise.all([
    waitForCatalog(state, state.current.codex, deadlineAt),
    waitForCatalog(state, state.current.claude, deadlineAt),
  ]);
  const editorResponses = await Promise.all([
    callTool(state, state.current.codex, 'editor_status', {}, false, deadlineAt),
    callTool(state, state.current.claude, 'editor_status', {}, false, deadlineAt),
  ]);
  for (const response of editorResponses) {
    assertEditorReady(editorObservation(response), state.options.projectPath);
  }
  await requireListChangedDelta(state, before, 'controlled restart', 0, deadlineAt);
  const { snapshot, target } = await statusSnapshot(state, state.current.codex, deadlineAt);
  if (snapshot.broker.pid !== state.identity.brokerPid || target.path !== state.options.projectPath ||
      !Number.isSafeInteger(target.child?.pid) || target.child.pid === priorChildPid) {
    throw new SoakPolicyError('controlled restart did not replace only the project child', 'CHILD_RESTART_IDENTITY_DRIFT');
  }
  const childCheck = assertProjectChildIdentities(snapshot, state.identity.projectChildren, {
    allowChangedPath: state.options.projectPath,
  });
  if (!childCheck.allowedChanged) {
    throw new SoakPolicyError('controlled restart did not change the target child identity', 'CHILD_RESTART_IDENTITY_DRIFT');
  }
  state.identity.childPid = target.child.pid;
  state.identity.projectChildren = childCheck.observed;
  identityFromStatus(state, snapshot);
  record(state, 'operation_complete', {
    operation: 'controlled_child_restart',
    dispatchCount: 1,
    mutationRetryCount: 0,
    previousChildPid: priorChildPid,
    childPid: state.identity.childPid,
    brokerPid: state.identity.brokerPid,
  });
}

async function performFairnessBurst(state) {
  const count = state.options.fairnessBurst;
  const before = listChangedBaseline(state);
  const deadlineAt = Math.min(state.overallDeadlineAt, state.clock.now() + state.operationTimeoutMs);
  const byClient = { codex: 0, claude: 0 };
  for (let index = 0; index < count; index += 1) {
    const logical = index % 2 === 0 ? 'codex' : 'claude';
    byClient[logical] += 1;
  }
  record(state, 'operation_start', {
    operation: 'fairness_noop_burst',
    dispatchCount: count,
    byClient,
    force: false,
    mutationRetryCount: 0,
  });
  const completions = [];
  const calls = [];
  for (let index = 0; index < count; index += 1) {
    const logical = index % 2 === 0 ? 'codex' : 'claude';
    state.dispatches.fairness += 1;
    calls.push(request(
      state,
      state.current[logical],
      'tools/call',
      { name: 'recompile', arguments: { focus: false } },
      true,
      deadlineAt,
    ).then((response) => {
      completions.push({
        logical,
        dispatchIndex: index,
        completedAtElapsedMs: state.clock.now() - state.startedAt,
      });
      return response;
    }));
  }
  let callsDone = false;
  const joined = Promise.allSettled(calls).then((value) => {
    callsDone = true;
    return value;
  });
  const monitor = (async () => {
    let samples = 0;
    let maxActiveHeavy = 0;
    let maxPendingTotal = 0;
    do {
      const observed = structuredResponse(await callTool(
        state,
        state.current.codex,
        'unity_router_status',
        {},
        false,
        deadlineAt,
      ), 'fairness status sample');
      samples += 1;
      maxActiveHeavy = Math.max(maxActiveHeavy, observed.budget?.activeHeavy ?? 0);
      maxPendingTotal = Math.max(maxPendingTotal, observed.budget?.pendingTotal ?? 0);
      if (maxActiveHeavy > 1) {
        throw new SoakPolicyError('global activeHeavy exceeded one during fairness burst', 'HEAVY_CAPACITY_EXCEEDED');
      }
      if (!callsDone) {
        await sleepWithinDeadline(state, Math.min(25, deadlineAt - state.clock.now()), deadlineAt, 'FAIRNESS_DEADLINE_EXCEEDED');
      }
    } while (!callsDone);
    return { samples, maxActiveHeavy, maxPendingTotal };
  })();
  // Both promises have rejection handlers immediately. Even if monitoring
  // fails, wait for every exactly-once mutation response before closeout.
  const [joinedOutcome, monitorOutcome] = await Promise.allSettled([joined, monitor]);
  if (joinedOutcome.status === 'rejected') throw joinedOutcome.reason;
  const settled = joinedOutcome.value;
  if (monitorOutcome.status === 'rejected') throw monitorOutcome.reason;
  const monitoring = monitorOutcome.value;
  if (settled.some((entry) => entry.status === 'rejected')) {
    throw new SoakPolicyError('fairness no-op dispatch failed; no call was retried', 'FAIRNESS_DISPATCH_FAILED');
  }
  const operationIds = [];
  for (const entry of settled) {
    assertNoopDispatch(recompileObservation(entry.value));
    const semantic = entry.value?.result?.structuredContent;
    const metadata = readRouterOperationMeta(entry.value?.result);
    if (typeof metadata?.routerOperationId !== 'string' || metadata.routerOperationId.length === 0 ||
        metadata.routerOperationState !== 'COMPLETED' || metadata.routerDeliveryAckRequired !== true) {
      throw new SoakPolicyError('fairness no-op omitted completed delivery metadata', 'FAIRNESS_OPERATION_METADATA_DRIFT');
    }
    if (
      semantic && typeof semantic === 'object' && !Array.isArray(semantic) &&
      ['routerOperationId', 'routerOperationState', 'routerDeliveryAckRequired', 'statusTool']
        .some((key) => Object.hasOwn(semantic, key))
    ) {
      throw new SoakPolicyError(
        'fairness no-op polluted structuredContent with router operation metadata',
        'FAIRNESS_OPERATION_METADATA_DRIFT',
      );
    }
    operationIds.push(metadata.routerOperationId);
  }
  if (new Set(operationIds).size !== count) {
    throw new SoakPolicyError('fairness no-op operation IDs are not unique', 'FAIRNESS_OPERATION_ID_DUPLICATE');
  }
  assertCleanTerminal(
    recompileObservation(await callTool(
      state,
      state.current.claude,
      'recompile_status',
      {},
      false,
      deadlineAt,
    )),
    'noop',
  );
  await sleepWithinDeadline(state, state.options.settleMs, deadlineAt, 'FAIRNESS_DEADLINE_EXCEEDED');
  harvestCurrentNotifications(state);
  for (const logical of ['codex', 'claude']) {
    const after = state.notificationTotals[logical]['notifications/tools/list_changed'] ?? 0;
    if (after !== before[logical]) {
      throw new SoakPolicyError('source-neutral fairness burst changed the tool catalog', 'FAIRNESS_NOT_SOURCE_NEUTRAL');
    }
  }
  if (state.dispatches.fairness !== count || byClient.codex !== byClient.claude) {
    throw new SoakPolicyError('fairness dispatch accounting drifted', 'FAIRNESS_ACCOUNTING_DRIFT');
  }
  const { snapshot } = await statusSnapshot(state, state.current.codex, deadlineAt);
  identityFromStatus(state, snapshot);
  record(state, 'operation_complete', {
    operation: 'fairness_noop_burst',
    dispatchCount: count,
    byClient,
    operationIds,
    completionOrder: completions,
    mutationRetryCount: 0,
    monitoringSamples: monitoring.samples,
    maxActiveHeavyObserved: monitoring.maxActiveHeavy,
    maxPendingObserved: monitoring.maxPendingTotal,
  });
}

function defaultClock() {
  const epochAtStart = Date.now();
  const monotonicAtStart = performance.now();
  return Object.freeze({
    now: () => epochAtStart + (performance.now() - monotonicAtStart),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

function publicFingerprint(value) {
  return {
    algorithm: value.algorithm,
    digest: value.digest,
    head: value.head,
    headRef: value.headRef,
    dirty: value.dirty,
    statusBytes: value.statusBytes,
    untrackedCount: value.untrackedCount,
    untrackedBytes: value.untrackedBytes,
    projectPath: value.projectPath,
    gitRoot: value.gitRoot,
  };
}

function assertEvidenceOutsideGitRoot(evidencePath, gitRoot) {
  const relative = path.relative(gitRoot, evidencePath);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new SoakPolicyError('evidence file must be outside the fingerprinted Git worktree', 'EVIDENCE_INSIDE_GIT_ROOT');
  }
}

export async function runSoak(options, runtime = {}) {
  const io = runtime.io ?? process;
  if (options.help) { io.stdout.write(`${USAGE}\n`); return { kind: 'help' }; }
  const timing = runtime.timing ?? {};
  const plan = buildSoakPlan(options, timing);
  const validateEvidence = runtime.validateEvidencePath ?? validateNewEvidencePath;
  validateEvidence(options.evidence);
  const captureFingerprint = runtime.captureFingerprint ?? ((projectPath) => captureGitDirtyFingerprint(projectPath));
  if (options.dryRun) {
    const fingerprint = await captureFingerprint(options.projectPath);
    assertEvidenceOutsideGitRoot(options.evidence, fingerprint.gitRoot);
    if (fingerprint.projectPath !== options.projectPath) {
      throw new SoakPolicyError('fingerprint project identity does not match --project-path', 'FINGERPRINT_PROJECT_MISMATCH');
    }
    const report = { dryRun: true, plan, preDirtyFingerprint: publicFingerprint(fingerprint) };
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return { kind: 'dry-run', ...report };
  }

  const clock = runtime.clock ?? defaultClock();
  let preFingerprint = await captureFingerprint(options.projectPath);
  assertEvidenceOutsideGitRoot(options.evidence, preFingerprint.gitRoot);
  if (preFingerprint.projectPath !== options.projectPath) {
    throw new SoakPolicyError('fingerprint project identity does not match --project-path', 'FINGERPRINT_PROJECT_MISMATCH');
  }
  const evidence = (runtime.evidenceFactory ?? openEvidenceFile)(options.evidence);
  const startedAt = clock.now();
  const state = {
    options,
    plan,
    clock,
    evidence,
    startedAt,
    overallDeadlineAt: startedAt + options.durationSec * 1_000 + options.operationTimeoutSec * 1_000,
    requestTimeoutMs: options.requestTimeoutSec * 1_000,
    operationTimeoutMs: options.operationTimeoutSec * 1_000,
    maxScheduleDriftMs: timing.maxScheduleDriftMs ?? Math.min(30_000, options.requestTimeoutSec * 1_000),
    makeClient: null,
    adminRestart: runtime.adminRestart ?? defaultAdminRestart,
    allClients: [],
    current: { codex: null, claude: null },
    identity: null,
    catalog: null,
    catalogHash: null,
    notificationCursors: new Map(),
    clientLogical: new Map(),
    notificationTotals: { codex: {}, claude: {} },
    expectedListChanged: { codex: 0, claude: 0 },
    dispatches: { reload: 0, restart: 0, fairness: 0 },
    reconnects: 0,
    safeReadRounds: 0,
    editorUnityVersion: null,
  };
  state.makeClient = runtime.clientFactory ?? ((name) => new SoakStdioClient({
    adapter: options.adapter,
    project: options.project,
    maxOutputBytes: options.maxOutputBytes,
    name,
    now: clock.now,
  }));

  let postFingerprint = null;
  let completed = false;
  let primaryError = null;
  try {
    record(state, 'start', {
      plan,
      preDirtyFingerprint: publicFingerprint(preFingerprint),
      evidenceMode: '0600',
      notificationAllowlist: [...NOTIFICATION_ALLOWLIST],
      contentCapture: false,
    });

    const codex = state.makeClient(CLIENT_NAMES.codex);
    const claude = state.makeClient(CLIENT_NAMES.claude);
    state.current = { codex, claude };
    state.allClients.push(codex, claude);
    registerClient(state, codex, 'codex');
    registerClient(state, claude, 'claude');
    await Promise.all([codex.initialize(callDeadline(state)), claude.initialize(callDeadline(state))]);
    const [listCodex, listClaude] = await Promise.all([
      request(state, codex, 'tools/list', {}),
      request(state, claude, 'tools/list', {}),
    ]);
    state.catalog = assertRequiredCatalog(listCodex, options.withReload || options.fairnessBurst > 0 ? 'reload' : 'noop');
    if (assertRequiredCatalog(listClaude, options.withReload || options.fairnessBurst > 0 ? 'reload' : 'noop') !== state.catalog) {
      throw new SoakPolicyError('Codex and Claude received different catalogs', 'CATALOG_CROSS_CLIENT_DRIFT');
    }
    state.catalogHash = hashCatalog(state.catalog);

    const baseline = await statusSnapshot(state);
    if (baseline.target.path !== options.projectPath) {
      throw new SoakPolicyError('project alias resolved to the wrong canonical path', 'PROJECT_ROUTE_MISMATCH');
    }
    assertBaselineProjectChildren(baseline.snapshot, options.project);
    const doctor = structuredResponse(await callTool(state, claude, 'unity_router_doctor'), 'baseline unity_router_doctor');
    assertCleanRouterState(baseline.snapshot, doctor, options.project);
    const baselineEditor = assertExactSingleEditor(
      baseline.snapshot.processAudit,
      options.projectPath,
      'baseline status process audit',
    );
    assertExactSingleEditor(doctor, options.projectPath, 'baseline doctor', baselineEditor.pid);
    state.identity = {
      brokerPid: baseline.snapshot.broker?.pid,
      childPid: baseline.target.child?.pid,
      buildId: baseline.snapshot.broker?.buildId,
      configHash: baseline.snapshot.broker?.configHash,
      toolsFingerprint: baseline.target.tools,
      editorPid: baselineEditor.pid,
      projectChildren: projectChildIdentities(baseline.snapshot),
    };
    for (const [name, value] of Object.entries(state.identity)) {
      if (value == null || (name.endsWith('Pid') && !Number.isSafeInteger(value))) {
        throw new SoakPolicyError(`baseline ${name} is missing`, 'BASELINE_IDENTITY_MISSING');
      }
    }
    assertRouterSnapshot(baseline.snapshot, {
      project: options.project,
      projectPath: options.projectPath,
      ...state.identity,
    });
    await simultaneousSafeRead(state, 'baseline');
    await takeSnapshot(state, 'baseline', { doctor: true });

    for (const event of buildSoakSchedule(options, timing)) {
      const dueAt = state.startedAt + event.atMs;
      if (clock.now() < dueAt) await clock.sleep(dueAt - clock.now());
      if (clock.now() > state.overallDeadlineAt) {
        throw new SoakPolicyError('whole-soak absolute deadline expired', 'SOAK_DEADLINE_EXCEEDED');
      }
      const cadenceEvent = ['safe-read', 'snapshot', 'final'].includes(event.kind);
      const dispatchDriftMs = cadenceEvent
        ? assertScheduleDrift(event.kind, dueAt, clock.now(), state.maxScheduleDriftMs)
        : Math.max(0, clock.now() - dueAt);
      if (event.kind === 'safe-read') {
        await simultaneousSafeRead(state, `periodic-${event.atMs / 1_000}s`, dueAt);
      } else if (event.kind === 'snapshot') {
        await takeSnapshot(state, `periodic-${event.atMs / 1_000}s`, { dispatchDriftMs });
      }
      else if (event.kind === 'reload') await performReload(state);
      else if (event.kind === 'reconnect') await performReconnect(state);
      else if (event.kind === 'restart') await performRestart(state);
      else if (event.kind === 'fairness') await performFairnessBurst(state);
      else if (event.kind === 'final') {
        await simultaneousSafeRead(state, 'final', dueAt);
        await takeSnapshot(state, 'final', { doctor: true, dispatchDriftMs });
      }
    }

    if (state.reconnects !== 1 || state.dispatches.reload !== plan.mutationDispatches.reload ||
        state.dispatches.restart !== plan.mutationDispatches.controlledChildRestart ||
        state.dispatches.fairness !== plan.mutationDispatches.fairnessNoopRecompile) {
      throw new SoakPolicyError('final dispatch/reconnect accounting drifted', 'FINAL_ACCOUNTING_DRIFT');
    }
    assertNotificationTotals(state);
    await Promise.all([
      state.current.codex.close({ requireGraceful: true }),
      state.current.claude.close({ requireGraceful: true }),
    ]);
    assertNotificationTotals(state);
    postFingerprint = await captureFingerprint(options.projectPath);
    assertFingerprintStable(preFingerprint, postFingerprint);
    const report = {
      ok: true,
      project: options.project,
      projectPath: options.projectPath,
      durationSec: options.durationSec,
      brokerPid: state.identity.brokerPid,
      childPid: state.identity.childPid,
      buildId: state.identity.buildId,
      configHash: state.identity.configHash,
      catalogHash: state.catalogHash,
      editorPid: state.identity.editorPid,
      editorUnityVersion: state.editorUnityVersion,
      projectChildren: state.identity.projectChildren,
      safeReadRounds: state.safeReadRounds,
      reconnects: state.reconnects,
      mutationDispatches: { ...state.dispatches },
      mutationRetries: 0,
      notificationCounts: {
        codexListChanged: state.notificationTotals.codex['notifications/tools/list_changed'] ?? 0,
        claudeListChanged: state.notificationTotals.claude['notifications/tools/list_changed'] ?? 0,
      },
      preDirtyFingerprint: preFingerprint.digest,
      postDirtyFingerprint: postFingerprint.digest,
      dirtyUnchanged: true,
      evidence: evidence.path,
      gracefulClientClose: true,
      cleanCloseout: true,
    };
    record(state, 'final', report);
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    completed = true;
    return report;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!completed) {
      // A timed-out mutation may still be executing. Closing its adapter first
      // lets the broker quarantine delivery/UNKNOWN state before any slower
      // filesystem evidence pass; the harness never attempts the mutation again.
      await Promise.allSettled(state.allClients.map((client) => client.close()));
    }
    if (!completed && preFingerprint && !postFingerprint) {
      try { postFingerprint = await captureFingerprint(options.projectPath); } catch { /* retain primary failure */ }
    }
    if (!completed) {
      try {
        record(state, 'final', {
          ok: false,
          error: { name: primaryError?.name ?? 'Error', code: safeCode(primaryError?.code) },
          mutationDispatches: { ...state.dispatches },
          mutationRetries: 0,
          reconnects: state.reconnects,
          notificationCounts: {
            codexListChanged: state.notificationTotals.codex['notifications/tools/list_changed'] ?? 0,
            claudeListChanged: state.notificationTotals.claude['notifications/tools/list_changed'] ?? 0,
          },
          preDirtyFingerprint: preFingerprint?.digest ?? null,
          postDirtyFingerprint: postFingerprint?.digest ?? null,
          dirtyUnchanged: preFingerprint && postFingerprint ? preFingerprint.digest === postFingerprint.digest : null,
        });
      } catch { /* evidence failure must not hide the primary error */ }
    }
    if (completed) await Promise.allSettled(state.allClients.map((client) => client.close()));
    evidence.close();
  }
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  let options;
  try {
    options = parseSoakArgs(argv);
    await runSoak(options, runtime);
    return 0;
  } catch (error) {
    const io = runtime.io ?? process;
    io.stderr.write(`live-soak: ${error.message}\n`);
    if (error instanceof SoakPolicyError) io.stderr.write('Use --help for guarded usage.\n');
    return error.exitCode ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
