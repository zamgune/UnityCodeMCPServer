#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function fail(message, code = 64) {
  process.stderr.write(`install-state: ${message}\n`);
  process.exit(code);
}

function syncDirectory(directory) {
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function syncRegularFile(file) {
  assertRegularOwned(file);
  const descriptor = openSync(file, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function syncTree(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`unsafe sync tree: ${root}`, 65);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink in sync tree: ${child}`, 65);
    if (entry.isDirectory()) syncTree(child);
    else if (entry.isFile()) syncRegularFile(child);
    else fail(`unsupported entry in sync tree: ${child}`, 65);
  }
  syncDirectory(root);
}

function assertRegularOwned(file) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`unsafe state path: ${file}`, 65);
  const uid = process.getuid?.();
  if (uid != null && stat.uid !== uid) fail(`state file owner mismatch: ${file}`, 65);
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  syncDirectory(directory);
}

function readJson(file) {
  assertRegularOwned(file);
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`state file is not valid JSON: ${file}`, 65);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('state root must be an object', 65);
  return value;
}

function optionMap(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value == null) fail('invalid option list');
    if (Object.hasOwn(values, flag)) fail(`duplicate option: ${flag}`);
    values[flag] = value;
  }
  return values;
}

function testBarrier(point, protectedFile) {
  if (process.env.UNITY_MCP_INSTALLER_TEST_MODE !== '1' ||
      process.env.UNITY_MCP_LOCK_TEST_POINT !== point) return;
  const ready = process.env.UNITY_MCP_LOCK_TEST_READY;
  const resume = process.env.UNITY_MCP_LOCK_TEST_RESUME;
  const isPrivateTmp = (value) => path.isAbsolute(value ?? '') &&
    (path.resolve(value).startsWith('/private/tmp/') || path.resolve(value).startsWith('/tmp/'));
  if (!isPrivateTmp(protectedFile) || !isPrivateTmp(ready) || !isPrivateTmp(resume)) {
    fail('lock test barrier is restricted to private tmp', 65);
  }
  const descriptor = openSync(ready, 'wx', 0o600);
  closeSync(descriptor);
  while (!existsSync(resume)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    const unreadable = new Error(`process liveness for ${pid} is unreadable`);
    unreadable.code = 'PROCESS_IDENTITY_UNREADABLE';
    throw unreadable;
  }
}

function processIdentity(pid) {
  if (!processExists(pid)) {
    const error = new Error(`process ${pid} is not running`);
    error.code = 'PROCESS_NOT_RUNNING';
    throw error;
  }
  let text;
  try {
    text = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        COLUMNS: '4096',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    let live;
    try { live = processExists(pid); } catch (error) { throw error; }
    const error = new Error(live
      ? `process identity for ${pid} is unreadable`
      : `process ${pid} is not running`);
    error.code = live ? 'PROCESS_IDENTITY_UNREADABLE' : 'PROCESS_NOT_RUNNING';
    throw error;
  }
  if (!text) {
    let live;
    try { live = processExists(pid); } catch (error) { throw error; }
    const error = new Error(live
      ? `process identity for ${pid} is unreadable`
      : `process ${pid} is not running`);
    error.code = live ? 'PROCESS_IDENTITY_UNREADABLE' : 'PROCESS_NOT_RUNNING';
    throw error;
  }
  const match = text.match(/^(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+([\s\S]+)$/);
  if (!match) {
    const error = new Error(`cannot parse process identity for ${pid}`);
    error.code = 'PROCESS_IDENTITY_UNREADABLE';
    throw error;
  }
  return { startTime: match[1].replace(/\s+/g, ' '), command: match[2] };
}

function shaFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const SHA = /^[a-f0-9]{64}$/;
const LOCK_ID = /^[a-f0-9]{32}$/;
const MANAGED_RUNTIME_STORAGE = 'managed-content-addressed-v1';

function validateLock(value) {
  if (![1, 2].includes(value.version) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.processStartTime !== 'string' || !value.processStartTime ||
      typeof value.processCommand !== 'string' || !value.processCommand ||
      typeof value.commandIdentity !== 'string' || typeof value.scriptPath !== 'string' ||
      !SHA.test(value.scriptSha256) || !path.isAbsolute(value.scriptPath) ||
      value.commandIdentity !== `install:${value.scriptSha256}` && value.commandIdentity !== `rollback:${value.scriptSha256}` ||
      value.version === 2 && !LOCK_ID.test(value.lockId ?? '') ||
      value.version === 1 && value.lockId !== undefined && !LOCK_ID.test(value.lockId)) fail('invalid lock record', 65);
  return value;
}

function lockIdentity(value) {
  return value.lockId ?? 'legacy-v1';
}

function assertExpectedLock(file, expectedLockId, expectedSha256) {
  if ((expectedLockId !== 'legacy-v1' && !LOCK_ID.test(expectedLockId ?? '')) || !SHA.test(expectedSha256 ?? '')) {
    fail('invalid expected lock identity', 65);
  }
  assertRegularOwned(file);
  const before = lstatSync(file);
  const value = validateLock(readJson(file));
  if (lockIdentity(value) !== expectedLockId || shaFile(file) !== expectedSha256) fail('lock identity changed', 73);
  const after = lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) fail('lock changed during verification', 73);
  return value;
}

function observeLock(value) {
  let state = 'unknown';
  let current = null;
  try {
    current = processIdentity(value.pid);
    if (current.startTime === value.processStartTime && current.command === value.processCommand) {
      state = 'live';
    } else {
      // A raw v1 writer observed ps through its caller's locale, timezone and
      // terminal width. While that PID still exists, a textual mismatch cannot
      // distinguish observer drift from PID reuse and must stay fail-closed.
      // v2 writers and readers both normalize ps, so their mismatch is a safe
      // stale/PID-reuse signal.
      state = value.version === 1 ? 'unknown' : 'stale';
    }
  } catch (error) {
    if (error?.code === 'PROCESS_NOT_RUNNING') {
      // New processes must never race an unpatched v1 helper that pre-read the
      // same legacy file before attempting its unguarded rename. Legacy v1
      // evidence therefore requires explicit offline recovery even when dead.
      state = value.version === 1 ? 'unknown' : 'stale';
    } else if (error?.code !== 'PROCESS_IDENTITY_UNREADABLE') {
      throw error;
    }
  }
  return { state, current };
}

function publishExactLock(file, payloadFile, expectedSha256) {
  assertRegularOwned(payloadFile);
  if (!SHA.test(expectedSha256 ?? '') || shaFile(payloadFile) !== expectedSha256) {
    fail('lock payload checksum mismatch', 65);
  }
  const payload = validateLock(readJson(payloadFile));
  if (payload.version !== 2 || !LOCK_ID.test(payload.lockId ?? '')) fail('new lock payload must be v2', 65);
  const bytes = readFileSync(payloadFile);
  let descriptor;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('install lock was taken during guarded acquisition', 73);
    throw error;
  }
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(file, 0o600);
  syncDirectory(path.dirname(file));
  if (shaFile(file) !== expectedSha256) fail('published lock checksum mismatch', 70);
  return payload;
}

function assertManagedRuntime(prefixValue, nodeSha256) {
  if (!path.isAbsolute(prefixValue) || !SHA.test(nodeSha256 ?? '')) fail('invalid managed runtime identity', 65);
  const prefix = path.resolve(prefixValue);
  if (realpathSync.native(prefix) !== prefix) fail('managed runtime prefix is not canonical', 65);
  const uid = process.getuid?.();
  const assertDirectory = (directory, parent, mode) => {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(directory) !== directory ||
        path.dirname(directory) !== parent || (uid != null && stat.uid !== uid) || (stat.mode & 0o777) !== mode) {
      fail(`unsafe managed runtime directory: ${directory}`, 65);
    }
  };
  const runtimes = path.join(prefix, 'runtimes');
  assertDirectory(runtimes, prefix, 0o700);
  const runtime = path.join(runtimes, nodeSha256);
  assertDirectory(runtime, runtimes, 0o500);
  if (JSON.stringify(readdirSync(runtime).sort()) !== JSON.stringify(['node'])) {
    fail(`managed runtime file set mismatch: ${runtime}`, 65);
  }
  const node = path.join(runtime, 'node');
  const stat = lstatSync(node);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync.native(node) !== node ||
      (uid != null && stat.uid !== uid) || (stat.mode & 0o777) !== 0o500 || stat.nlink !== 1 ||
      shaFile(node) !== nodeSha256) fail(`unsafe managed Node runtime: ${node}`, 65);
  return { storage: MANAGED_RUNTIME_STORAGE, prefix, runtimes, runtime, node, nodeSha256 };
}

const TRANSACTION_PHASES = new Set([
  'PREPARED', 'DRAIN_INTENT', 'DRAINED', 'BOOTOUT_INTENT', 'BOOTED_OUT',
  'PREVIOUS_SWITCH_INTENT', 'PREVIOUS_SWITCHED', 'CURRENT_SWITCH_INTENT',
  'CURRENT_SWITCHED', 'PLIST_SWITCH_INTENT', 'PLIST_SWITCHED',
  'BOOTSTRAP_INTENT', 'JOB_BOOTSTRAPPED', 'VERIFIED', 'RESTORE_FAILED',
]);

function validateTransaction(value) {
  if (value.version !== 1 || !['install', 'rollback'].includes(value.operation) ||
      typeof value.transactionId !== 'string' || !value.transactionId ||
      !TRANSACTION_PHASES.has(value.phase) || typeof value.prefix !== 'string' || !path.isAbsolute(value.prefix) ||
      typeof value.candidateTarget !== 'string' || !/^deployments\/d-[a-f0-9]{32}$/.test(value.candidateTarget) ||
      (value.oldCurrentTarget !== null && !/^deployments\/d-[a-f0-9]{32}$/.test(value.oldCurrentTarget)) ||
      (value.oldPreviousTarget !== null && !/^deployments\/d-[a-f0-9]{32}$/.test(value.oldPreviousTarget)) ||
      typeof value.backupDir !== 'string' || !path.isAbsolute(value.backupDir) ||
      typeof value.plistPath !== 'string' || !path.isAbsolute(value.plistPath) ||
      typeof value.plistExisted !== 'boolean' || typeof value.oldJobLoaded !== 'boolean' ||
      (value.oldJobPid !== null && (!Number.isSafeInteger(value.oldJobPid) || value.oldJobPid <= 0)) ||
      typeof value.staging !== 'boolean' || typeof value.label !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.label) ||
      typeof value.launchctlBin !== 'string' || !path.isAbsolute(value.launchctlBin) ||
      !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) fail('invalid transaction record', 65);
  return value;
}

const [command, ...argv] = process.argv.slice(2);
if (command === 'lock-payload') {
  const options = optionMap(argv);
  const pid = Number(options['--pid']);
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('invalid --pid');
  const scriptPath = options['--script-path'];
  const scriptSha256 = options['--script-sha256'];
  const commandIdentity = options['--command-identity'];
  if (!path.isAbsolute(scriptPath) || !SHA.test(scriptSha256 ?? '') ||
      !new RegExp(`^(install|rollback):${scriptSha256}$`).test(commandIdentity ?? '')) fail('invalid lock identity');
  assertRegularOwned(scriptPath);
  if (shaFile(scriptPath) !== scriptSha256) fail('lock script checksum mismatch', 65);
  let identity;
  try { identity = processIdentity(pid); } catch (error) { fail(error.message, 66); }
  process.stdout.write(`${JSON.stringify({
    // Raw v1 control planes must reject this record rather than reinterpret a
    // live owner through their locale-sensitive ps parser. Only the new helper
    // may reclaim a stale v2 record; legacy v1 records remain readable below.
    version: 2,
    lockId: randomBytes(16).toString('hex'),
    pid,
    processStartTime: identity.startTime,
    processCommand: identity.command,
    commandIdentity,
    scriptPath,
    scriptSha256,
    acquiredAt: new Date().toISOString(),
  })}\n`);
} else if (command === 'lock-status') {
  const options = optionMap(argv);
  const file = options['--file'];
  const value = validateLock(readJson(file));
  const { state, current } = observeLock(value);
  let scriptIntegrity = 'unreadable';
  try {
    scriptIntegrity = existsSync(value.scriptPath) && !lstatSync(value.scriptPath).isSymbolicLink() &&
      shaFile(value.scriptPath) === value.scriptSha256 ? 'valid' : 'drifted';
  } catch {}
  process.stdout.write(`${JSON.stringify({
    state,
    live: state === 'live',
    reclaimable: state === 'stale',
    lockId: lockIdentity(value),
    lockSha256: shaFile(file),
    scriptIntegrity,
    owner: value,
    current,
  })}\n`);
} else if (command === 'lock-acquire') {
  const options = optionMap(argv);
  const file = options['--file'];
  const destination = options['--destination'];
  if (path.dirname(file) !== path.dirname(destination)) fail('stale lock destination must share its directory', 65);
  if (existsSync(destination)) fail('stale lock evidence destination already exists', 65);
  if (existsSync(file)) {
    const value = validateLock(readJson(file));
    const { state } = observeLock(value);
    if (state === 'live') fail('another live install/rollback owns the O_EXCL lock', 73);
    if (value.version === 1) fail('legacy v1 install lock requires explicit offline recovery', 75);
    if (state !== 'stale') fail('install lock owner state is unknown and cannot be reclaimed', 75);
    const expectedLockId = lockIdentity(value);
    const expectedSha256 = shaFile(file);
    assertExpectedLock(file, expectedLockId, expectedSha256);
    testBarrier('acquire-after-verify', file);
    assertExpectedLock(file, expectedLockId, expectedSha256);
    renameSync(file, destination);
    syncDirectory(path.dirname(file));
  }
  const payload = publishExactLock(file, options['--payload'], options['--payload-sha256']);
  process.stdout.write(`${JSON.stringify({ acquired: true, lockId: payload.lockId })}\n`);
} else if (command === 'reclaim-lock') {
  fail('unguarded reclaim-lock is disabled; use lock-acquire', 69);
} else if (command === 'lock-release') {
  const options = optionMap(argv);
  const file = options['--file'];
  assertExpectedLock(file, options['--expected-lock-id'], options['--expected-sha256']);
  testBarrier('release-after-verify', file);
  assertExpectedLock(file, options['--expected-lock-id'], options['--expected-sha256']);
  unlinkSync(file);
  syncDirectory(path.dirname(file));
} else if (command === 'transaction-begin') {
  const options = optionMap(argv);
  const file = options['--file'];
  if (existsSync(file)) fail('transaction marker already exists', 73);
  const value = {
    version: 1,
    transactionId: options['--transaction-id'],
    operation: options['--operation'],
    phase: 'PREPARED',
    prefix: options['--prefix'],
    candidateTarget: options['--candidate-target'],
    oldCurrentTarget: options['--old-current-target'] || null,
    oldPreviousTarget: options['--old-previous-target'] || null,
    backupDir: options['--backup-dir'],
    plistPath: options['--plist-path'],
    plistExisted: options['--plist-existed'] === '1',
    oldJobLoaded: options['--old-job-loaded'] === '1',
    oldJobPid: options['--old-job-pid'] ? Number(options['--old-job-pid']) : null,
    staging: options['--staging'] === '1',
    label: options['--label'],
    launchctlBin: options['--launchctl-bin'],
    startedAt: new Date().toISOString(),
    ownerPid: Number(options['--owner-pid']),
  };
  validateTransaction(value);
  atomicJson(file, value);
} else if (command === 'transaction-phase') {
  const options = optionMap(argv);
  const value = validateTransaction(readJson(options['--file']));
  if (!TRANSACTION_PHASES.has(options['--phase'])) fail('invalid transaction phase', 65);
  value.phase = options['--phase'];
  value.updatedAt = new Date().toISOString();
  atomicJson(options['--file'], value);
} else if (command === 'transaction-read') {
  const options = optionMap(argv);
  process.stdout.write(`${JSON.stringify(validateTransaction(readJson(options['--file'])))}\n`);
} else if (command === 'transaction-clear') {
  const options = optionMap(argv);
  validateTransaction(readJson(options['--file']));
  unlinkSync(options['--file']);
  syncDirectory(path.dirname(options['--file']));
} else if (command === 'sync-file') {
  const options = optionMap(argv);
  syncRegularFile(options['--file']);
  syncDirectory(path.dirname(options['--file']));
} else if (command === 'sync-parent') {
  const options = optionMap(argv);
  syncDirectory(path.dirname(options['--path']));
} else if (command === 'sync-tree') {
  const options = optionMap(argv);
  syncTree(options['--path']);
  syncDirectory(path.dirname(options['--path']));
} else if (command === 'runtime-audit') {
  const options = optionMap(argv);
  process.stdout.write(`${JSON.stringify(assertManagedRuntime(options['--prefix'], options['--node-sha256']))}\n`);
} else {
  fail('unknown command');
}
