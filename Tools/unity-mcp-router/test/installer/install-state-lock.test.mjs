import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HELPER = path.join(ROOT, 'scripts', 'install-state.mjs');
const INSTALL = path.join(ROOT, 'scripts', 'install-router.sh');
const PINNED_NODE_CANDIDATES = [
  '/Volumes/WD_1TB/Dependencies/Node/node-v24.18.0-darwin-arm64/bin/node',
  '/usr/local/bin/node',
  process.execPath,
];
const NODE = PINNED_NODE_CANDIDATES.find((candidate) =>
  existsSync(candidate) && !lstatSync(candidate).isSymbolicLink());

// This is the immutable deployment that was live immediately before the
// managed-runtime migration on this Mac. Its helper is intentionally consumed
// byte-for-byte so the compatibility proof does not silently exercise the new
// implementation on both sides.
const RAW_V1_HELPER = '/Users/zamgune/.unity-mcp-router/deployments/d-348b280786abc8b0332aa93d747a4fa7/install-state.mjs';
const RAW_V1_HELPER_SHA256 = 'ce448aba97414f3192cee515c7a8d5f516f0cb5dcac761a86aaedddd2dd9ceb2';

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fixture(t) {
  const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  const base = mkdtempSync(path.join(temporaryRoot, 'unity-router-lock-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ownerScript = path.join(base, 'immutable-lock-owner.sh');
  copyFileSync(INSTALL, ownerScript);
  chmodSync(ownerScript, 0o500);
  return {
    base,
    ownerScript,
    ownerSha: sha256(ownerScript),
    lock: path.join(base, 'install.lock'),
  };
}

function payloadBytes(f, env = {}) {
  const result = spawnSync(NODE, [
    HELPER,
    'lock-payload',
    '--pid', String(process.pid),
    '--command-identity', `install:${f.ownerSha}`,
    '--script-path', f.ownerScript,
    '--script-sha256', f.ownerSha,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function payloadFor(f, env = {}) {
  const bytes = payloadBytes(f, env);
  writeFileSync(f.lock, bytes, { mode: 0o600 });
  return JSON.parse(bytes);
}

function spawnCollected(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for lock test barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('lock identity is stable across terminal locale, timezone, and width differences', (t) => {
  const f = fixture(t);
  payloadFor(f, {
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'Asia/Seoul',
    COLUMNS: '17',
  });
  const status = spawnSync(NODE, [HELPER, 'lock-status', '--file', f.lock], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      COLUMNS: '8192',
    },
  });
  assert.equal(status.status, 0, status.stderr);
  const observed = JSON.parse(status.stdout);
  assert.equal(observed.state, 'live');
  assert.equal(observed.live, true);
  assert.equal(observed.reclaimable, false);
});

test('a missing PID is stale, while a live owner remains live when only script integrity drifts', (t) => {
  const f = fixture(t);
  const payload = payloadFor(f);
  chmodSync(f.ownerScript, 0o700);
  writeFileSync(f.ownerScript, `${readFileSync(f.ownerScript, 'utf8')}\n# post-acquisition drift\n`);
  chmodSync(f.ownerScript, 0o500);
  const live = spawnSync(NODE, [HELPER, 'lock-status', '--file', f.lock], { encoding: 'utf8' });
  assert.equal(live.status, 0, live.stderr);
  const liveStatus = JSON.parse(live.stdout);
  assert.equal(liveStatus.state, 'live');
  assert.equal(liveStatus.reclaimable, false);
  assert.equal(liveStatus.scriptIntegrity, 'drifted');

  const staleRecord = { ...payload, pid: 99999999 };
  writeFileSync(f.lock, `${JSON.stringify(staleRecord)}\n`, { mode: 0o600 });
  const stale = spawnSync(NODE, [HELPER, 'lock-status', '--file', f.lock], { encoding: 'utf8' });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).state, 'stale');
  assert.equal(JSON.parse(stale.stdout).reclaimable, true);
});

test('a ps observer failure for a live PID is unknown and never reclaimable', (t) => {
  const f = fixture(t);
  payloadFor(f);
  const unreadableHelper = path.join(f.base, 'install-state-unreadable.mjs');
  const original = readFileSync(HELPER, 'utf8');
  const modified = original.replace("execFileSync('/bin/ps'", "execFileSync('/definitely-missing/ps'");
  assert.notEqual(modified, original);
  writeFileSync(unreadableHelper, modified, { mode: 0o500 });

  const status = spawnSync(NODE, [unreadableHelper, 'lock-status', '--file', f.lock], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const observed = JSON.parse(status.stdout);
  assert.equal(observed.state, 'unknown');
  assert.equal(observed.live, false);
  assert.equal(observed.reclaimable, false);
});

test('the exact raw-v1 helper rejects a v2 lock before locale-sensitive observation', {
  skip: !existsSync(RAW_V1_HELPER) || sha256(RAW_V1_HELPER) !== RAW_V1_HELPER_SHA256,
}, (t) => {
  const f = fixture(t);
  const payload = payloadFor(f, {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    COLUMNS: '4096',
  });
  assert.match(payload.lockId, /^[a-f0-9]{32}$/);

  const raw = spawnSync(NODE, [RAW_V1_HELPER, 'lock-status', '--file', f.lock], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      COLUMNS: '4096',
    },
  });
  assert.equal(raw.status, 65, raw.stderr);
  assert.match(raw.stderr, /invalid lock record/);
});

test('the new helper preserves exact legacy-v1 live and non-reclaimable compatibility', {
  skip: !existsSync(RAW_V1_HELPER) || sha256(RAW_V1_HELPER) !== RAW_V1_HELPER_SHA256,
}, (t) => {
  const f = fixture(t);
  const legacy = spawnSync(NODE, [
    RAW_V1_HELPER,
    'lock-payload',
    '--pid', String(process.pid),
    '--command-identity', `install:${f.ownerSha}`,
    '--script-path', f.ownerScript,
    '--script-sha256', f.ownerSha,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      COLUMNS: '4096',
    },
  });
  assert.equal(legacy.status, 0, legacy.stderr);
  const legacyRecord = JSON.parse(legacy.stdout);
  assert.equal(legacyRecord.version, 1);
  assert.equal(legacyRecord.lockId, undefined);
  writeFileSync(f.lock, legacy.stdout, { mode: 0o600 });

  const live = spawnSync(NODE, [HELPER, 'lock-status', '--file', f.lock], { encoding: 'utf8' });
  assert.equal(live.status, 0, live.stderr);
  const liveStatus = JSON.parse(live.stdout);
  assert.equal(liveStatus.state, 'live');
  assert.equal(liveStatus.lockId, 'legacy-v1');
  assert.equal(liveStatus.reclaimable, false);

  writeFileSync(f.lock, `${JSON.stringify({
    ...legacyRecord,
    processStartTime: 'Mon Jan 1 00:00:00 1990',
  })}\n`, { mode: 0o600 });
  const mismatched = spawnSync(NODE, [HELPER, 'lock-status', '--file', f.lock], { encoding: 'utf8' });
  assert.equal(mismatched.status, 0, mismatched.stderr);
  const mismatchStatus = JSON.parse(mismatched.stdout);
  assert.equal(mismatchStatus.state, 'unknown');
  assert.equal(mismatchStatus.lockId, 'legacy-v1');
  assert.equal(mismatchStatus.reclaimable, false);

  writeFileSync(f.lock, `${JSON.stringify({ ...legacyRecord, pid: 99999999 })}\n`, { mode: 0o600 });
  const stale = spawnSync(NODE, [HELPER, 'lock-status', '--file', f.lock], { encoding: 'utf8' });
  assert.equal(stale.status, 0, stale.stderr);
  const staleStatus = JSON.parse(stale.stdout);
  assert.equal(staleStatus.state, 'unknown');
  assert.equal(staleStatus.lockId, 'legacy-v1');
  assert.equal(staleStatus.reclaimable, false);
});

test('whole-operation guard serializes stale-v2 acquisition and preserves the sole winner bytes', async (t) => {
  const f = fixture(t);
  const guard = path.join(f.base, 'install-lock-cas.guard');
  const payloadA = path.join(f.base, 'payload-a.json');
  const payloadB = path.join(f.base, 'payload-b.json');
  const staleEvidenceA = path.join(f.base, 'stale-a.json');
  const staleEvidenceB = path.join(f.base, 'stale-b.json');
  const ready = path.join(f.base, 'acquire.ready');
  const resume = path.join(f.base, 'acquire.resume');
  writeFileSync(guard, '', { mode: 0o600 });
  const bytesA = payloadBytes(f);
  const bytesB = payloadBytes(f);
  writeFileSync(payloadA, bytesA, { mode: 0o600 });
  writeFileSync(payloadB, bytesB, { mode: 0o600 });
  const staleBytes = `${JSON.stringify({ ...JSON.parse(bytesA), pid: 99999999 })}\n`;
  writeFileSync(f.lock, staleBytes, { mode: 0o600 });
  const lockAcquireArgs = (payload, destination) => [
    '-k', '-s', '-t', '5', guard,
    NODE, HELPER, 'lock-acquire', '--file', f.lock,
    '--payload', payload, '--payload-sha256', sha256(payload),
    '--destination', destination,
  ];
  const first = spawnCollected('/usr/bin/lockf', lockAcquireArgs(payloadA, staleEvidenceA), {
    env: {
      ...process.env,
      UNITY_MCP_INSTALLER_TEST_MODE: '1',
      UNITY_MCP_LOCK_TEST_POINT: 'acquire-after-verify',
      UNITY_MCP_LOCK_TEST_READY: ready,
      UNITY_MCP_LOCK_TEST_RESUME: resume,
    },
  });
  t.after(() => { if (first.child.exitCode == null) first.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));
  const second = spawnCollected('/usr/bin/lockf', lockAcquireArgs(payloadB, staleEvidenceB), {
    env: process.env,
  });
  t.after(() => { if (second.child.exitCode == null) second.child.kill('SIGKILL'); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(resume, 'resume\n', { mode: 0o600 });
  const [winner, loser] = await Promise.all([first.completed, second.completed]);
  assert.equal(winner.status, 0, winner.stderr);
  assert.equal(loser.status, 73, loser.stderr);
  assert.deepEqual(readFileSync(f.lock), readFileSync(payloadA));
  assert.equal(readFileSync(staleEvidenceA, 'utf8'), staleBytes);
  assert.equal(existsSync(staleEvidenceB), false);
});

test('whole-operation guard serializes release before the next exact acquisition', async (t) => {
  const f = fixture(t);
  const guard = path.join(f.base, 'install-lock-cas.guard');
  const payloadB = path.join(f.base, 'payload-b.json');
  const staleEvidenceB = path.join(f.base, 'stale-b.json');
  const ready = path.join(f.base, 'release.ready');
  const resume = path.join(f.base, 'release.resume');
  writeFileSync(guard, '', { mode: 0o600 });
  const owner = payloadFor(f);
  const ownerSha = sha256(f.lock);
  const bytesB = payloadBytes(f);
  writeFileSync(payloadB, bytesB, { mode: 0o600 });
  const releasing = spawnCollected('/usr/bin/lockf', [
    '-k', '-s', '-t', '5', guard,
    NODE, HELPER, 'lock-release', '--file', f.lock,
    '--expected-lock-id', owner.lockId, '--expected-sha256', ownerSha,
  ], {
    env: {
      ...process.env,
      UNITY_MCP_INSTALLER_TEST_MODE: '1',
      UNITY_MCP_LOCK_TEST_POINT: 'release-after-verify',
      UNITY_MCP_LOCK_TEST_READY: ready,
      UNITY_MCP_LOCK_TEST_RESUME: resume,
    },
  });
  t.after(() => { if (releasing.child.exitCode == null) releasing.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));
  const acquiring = spawnCollected('/usr/bin/lockf', [
    '-k', '-s', '-t', '5', guard,
    NODE, HELPER, 'lock-acquire', '--file', f.lock,
    '--payload', payloadB, '--payload-sha256', sha256(payloadB),
    '--destination', staleEvidenceB,
  ], { env: process.env });
  t.after(() => { if (acquiring.child.exitCode == null) acquiring.child.kill('SIGKILL'); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(resume, 'resume\n', { mode: 0o600 });
  const [released, acquired] = await Promise.all([releasing.completed, acquiring.completed]);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.deepEqual(readFileSync(f.lock), readFileSync(payloadB));
  assert.equal(existsSync(staleEvidenceB), false);
});
