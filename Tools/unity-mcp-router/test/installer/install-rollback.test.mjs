import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const INSTALL = path.join(ROOT, 'scripts', 'install-router.sh');
const FAKE_UNITY = path.join(ROOT, 'test', 'fixtures', 'fake-unity.mjs');
const FAKE_LAUNCHCTL_SOURCE = path.join(ROOT, 'test', 'installer', 'fake-launchctl.mjs');
const RAW_V1_CONTROL_PLANE = '/Users/zamgune/.unity-mcp-router/deployments/d-348b280786abc8b0332aa93d747a4fa7';
const RAW_V1_STABLE_ROLLBACK = path.join(ROOT, 'test', 'fixtures', 'raw-v1-unity-mcp-router-rollback.sh');
const RAW_V1_STABLE_ROLLBACK_SHA256 = '8ad7310c1d75005c2ea767756b6b36f438fb0623f0249f566a538762c587969d';
const RAW_V1_CONTROL_PLANE_SHA256 = Object.freeze({
  'rollback-launcher.sh': '41ebff6eaf2e58e7473a06d663cfeee25578850583e5f2bc1dafa08aee94cad1',
  'rollback-router.sh': 'cbbba228eff05f93c454ae3e4621f9c3adc66fc08a5e5bad0b68e445f51f90fb',
  'install-state.mjs': 'ce448aba97414f3192cee515c7a8d5f516f0cb5dcac761a86aaedddd2dd9ceb2',
  'deployment-audit.mjs': 'fe408b9e785fe0d9b1a2e0334dde77811e85785a4b39f33946dfa652afd765dc',
});
const PINNED_NODE_CANDIDATES = [
  '/Volumes/WD_1TB/Dependencies/Node/node-v24.18.0-darwin-arm64/bin/node',
  '/usr/local/bin/node',
  process.execPath,
];
const INSTALL_NODE = PINNED_NODE_CANDIDATES.find((candidate) =>
  existsSync(candidate) && !lstatSync(candidate).isSymbolicLink());
const NON_SELF_CONTAINED_NODE = '/opt/homebrew/Cellar/node/25.4.0/bin/node';

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function rawV1ControlPlaneAvailable() {
  return existsSync(RAW_V1_STABLE_ROLLBACK) &&
    !lstatSync(RAW_V1_STABLE_ROLLBACK).isSymbolicLink() &&
    sha256(RAW_V1_STABLE_ROLLBACK) === RAW_V1_STABLE_ROLLBACK_SHA256 &&
    Object.entries(RAW_V1_CONTROL_PLANE_SHA256).every(([relative, expected]) => {
    const file = path.join(RAW_V1_CONTROL_PLANE, relative);
    return existsSync(file) && !lstatSync(file).isSymbolicLink() && sha256(file) === expected;
  });
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function removeFixtureTree(base) {
  if (existsSync(base)) makeTreeWritable(base);
  rmSync(base, { recursive: true, force: true });
}

function fixture(t, { cleanup = true } = {}) {
  const base = mkdtempSync(path.join('/private/tmp', 'unity-router-installer-'));
  if (cleanup) t.after(() => removeFixtureTree(base));
  const project = path.join(base, 'Game');
  const source = path.join(base, 'source-base');
  const prefix = path.join(base, 'install');
  const launchAgents = path.join(base, 'LaunchAgents');
  const state = path.join(base, 'state');
  mkdirSync(path.join(project, 'Assets'), { recursive: true });
  mkdirSync(path.join(project, 'ProjectSettings'));
  mkdirSync(state);
  cpSync(ROOT, source, { recursive: true });
  const config = path.join(base, 'router.json');
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 2,
    unityBin: '/usr/bin/true',
    minimumCliVersion: '1.0.0-beta.3',
    defaultProject: 'Game',
    projects: [{ name: 'Game', path: project }],
    logFile: path.join(state, 'broker.log'),
    license: { mode: 'single-seat', maxConcurrentEditors: 1 },
    broker: {
      socketPath: path.join(state, 'broker.sock'),
      journalFile: path.join(state, 'operations.jsonl'),
      workspaceLeaseFile: path.join(state, 'workspace.json'),
      adminTokenFile: path.join(state, 'admin-token'),
    },
  }, null, 2)}\n`);
  const nodeBin = INSTALL_NODE;
  const nodeSha = sha256(nodeBin);
  return { base, source, project, prefix, launchAgents, state, config, nodeBin, nodeSha };
}

function fixtureBrokerPids(launchctlState, extraPids = []) {
  const pids = new Set(extraPids);
  if (existsSync(launchctlState)) {
    try {
      const state = JSON.parse(readFileSync(launchctlState, 'utf8'));
      if (Number.isSafeInteger(state.pid) && state.pid > 0) pids.add(state.pid);
      for (const event of state.events ?? []) {
        if (event?.event === 'start' && Number.isSafeInteger(event.pid) && event.pid > 0) pids.add(event.pid);
      }
    } catch {}
  }
  const ledger = `${launchctlState}.started-pids`;
  if (existsSync(ledger)) {
    for (const value of readFileSync(ledger, 'utf8').split(/\s+/)) {
      const pid = Number(value);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

function processCommandWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaping = false;
  for (const char of String(command ?? '')) {
    if (escaping) {
      word += char;
      escaping = false;
    } else if (char === '\\' && quote !== "'") {
      escaping = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = '';
      }
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

function isFixtureBroker(pid, base) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (result.status !== 0) return false;
  const prefix = `${path.resolve(base)}${path.sep}`;
  return processCommandWords(result.stdout).some((word) =>
    word.startsWith(prefix) && path.basename(word) === 'broker-daemon.mjs');
}

function terminateFixtureBrokers(launchctlState, base, extraPids = []) {
  const survivors = [];
  for (const pid of fixtureBrokerPids(launchctlState, extraPids)) {
    if (!isFixtureBroker(pid, base)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
    let deadline = Date.now() + 2_000;
    while (Date.now() < deadline && isFixtureBroker(pid, base)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (isFixtureBroker(pid, base)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      deadline = Date.now() + 2_000;
      while (Date.now() < deadline && isFixtureBroker(pid, base)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    if (isFixtureBroker(pid, base)) survivors.push(pid);
  }
  return survivors;
}

function liveFixture(t) {
  const f = fixture(t, { cleanup: false });
  const extraOwnedPids = new Set();
  const fakeLaunchctl = path.join(f.base, 'fake-launchctl');
  const fakeLaunchctlModule = path.join(f.base, 'fake-launchctl.mjs');
  const launchctlState = path.join(f.base, 'fake-launchctl-state.json');
  cpSync(FAKE_LAUNCHCTL_SOURCE, fakeLaunchctlModule);
  writeFileSync(fakeLaunchctl,
    `#!/bin/sh\nexec ${shellSingleQuote(f.nodeBin)} ${shellSingleQuote(fakeLaunchctlModule)} "$@"\n`,
    { mode: 0o700 });
  chmodSync(FAKE_UNITY, 0o755);
  const value = JSON.parse(readFileSync(f.config, 'utf8'));
  value.unityBin = process.execPath;
  value.unityArgs = [FAKE_UNITY];
  value.reauthIntervalMin = 0;
  value.license = { mode: 'floating', maxConcurrentEditors: 2 };
  value.broker.processAuditEnforcement = 'report-only';
  writeFileSync(f.config, `${JSON.stringify(value, null, 2)}\n`);
  const label = `com.zamgune.unity-mcp-router.fixture.${process.pid}.${path.basename(f.base).replaceAll('-', '')}`;
  const env = {
    FAKE_LAUNCHCTL_STATE: launchctlState,
    FAKE_UNITY_VERSION: '1.0.0-beta.3',
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_SKIP_EXTERNAL_PROCESS_AUDIT: '1',
  };
  t.after(() => {
    const survivors = terminateFixtureBrokers(launchctlState, f.base, extraOwnedPids);
    assert.deepEqual(survivors, [], `fixture brokers survived teardown: ${survivors.join(', ')}`);
    removeFixtureTree(f.base);
  });
  return {
    ...f,
    fakeLaunchctl,
    launchctlState,
    label,
    env,
    ownBrokerPid(pid) {
      assert(Number.isSafeInteger(pid) && pid > 0, `invalid owned fixture PID: ${pid}`);
      extraOwnedPids.add(pid);
    },
  };
}

function installArgs(f, source = f.source, extra = []) {
  return [
    INSTALL,
    '--source', source,
    '--config', f.config,
    '--prefix', f.prefix,
    '--node-bin', f.nodeBin,
    '--node-sha256', f.nodeSha,
    '--launch-agents-dir', f.launchAgents,
    '--staging',
    ...extra,
  ];
}

function liveInstallArgs(f, source = f.source, extra = []) {
  return [
    INSTALL,
    '--source', source,
    '--config', f.config,
    '--prefix', f.prefix,
    '--node-bin', f.nodeBin,
    '--node-sha256', f.nodeSha,
    '--launch-agents-dir', f.launchAgents,
    '--launchctl-bin', f.fakeLaunchctl,
    '--label', f.label,
    '--verify-timeout-sec', '20',
    ...extra,
  ];
}

function runShell(args) {
  return spawnSync('/bin/sh', args, { encoding: 'utf8', timeout: 30_000 });
}

function runShellWithEnv(args, env, timeout = 60_000) {
  return spawnSync('/bin/sh', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
  });
}

function runShellAsync(args, env = {}) {
  const child = spawn('/bin/sh', args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function waitUntil(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for installer failpoint');
}

function cloneReleaseSource(f, version) {
  const source = path.join(f.base, `source-${version}`);
  cpSync(f.source, source, { recursive: true });
  const releaseFile = path.join(source, 'release.json');
  const release = JSON.parse(readFileSync(releaseFile, 'utf8'));
  release.version = version;
  release.buildId = `fixture-${version}`;
  release.journalFormat = 2;
  writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(path.join(source, 'rogue-secret.txt'), 'must never enter an installed release\n');
  return source;
}

function manifestPaths(releaseDir) {
  return readFileSync(path.join(releaseDir, 'SHA256SUMS'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => line.slice(66));
}

function releaseDirectory(prefix, deploymentDir) {
  const releaseId = readFileSync(path.join(deploymentDir, 'release-id.txt'), 'utf8').trim();
  return path.join(prefix, 'releases', releaseId);
}

function makeTreeWritable(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chmodSync(file, 0o700);
      makeTreeWritable(file);
    } else if (!entry.isSymbolicLink()) {
      chmodSync(file, 0o600);
    }
  }
  chmodSync(directory, 0o700);
}

function rewriteManifest(directory) {
  const manifest = path.join(directory, 'SHA256SUMS');
  const paths = readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.slice(66));
  writeFileSync(manifest, `${paths.map((relative) => `${sha256(path.join(directory, relative))}  ${relative}`).join('\n')}\n`);
}

function makeLegacyPrevious(f) {
  const previousTarget = readlinkSync(path.join(f.prefix, 'previous'));
  const previousDir = path.join(f.prefix, previousTarget);
  const sourceRelease = releaseDirectory(f.prefix, previousDir);
  const sourceSha = sha256(path.join(sourceRelease, 'SOURCE_SHA256SUMS'));
  const legacyVersion = '1.9.9-fixture';
  const legacyReleaseId = `${legacyVersion}-${sourceSha.slice(0, 12)}`;
  const legacyRelease = path.join(f.prefix, 'releases', legacyReleaseId);
  cpSync(sourceRelease, legacyRelease, { recursive: true });
  makeTreeWritable(legacyRelease);
  const releaseFile = path.join(legacyRelease, 'release.json');
  const release = JSON.parse(readFileSync(releaseFile, 'utf8'));
  release.version = legacyVersion;
  release.buildId = `sha256:${sourceSha}`;
  release.journalFormat = 1;
  writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
  rewriteManifest(legacyRelease);

  const temporary = path.join(f.prefix, 'deployments', `.legacy-${process.pid}`);
  cpSync(previousDir, temporary, { recursive: true });
  makeTreeWritable(temporary);
  const configSha = sha256(path.join(temporary, 'config.json'));
  const configId = `${legacyReleaseId}-${configSha.slice(0, 12)}`;
  writeFileSync(path.join(temporary, 'release-id.txt'), `${legacyReleaseId}\n`);
  writeFileSync(path.join(temporary, 'config-id.txt'), `${configId}\n`);
  writeFileSync(path.join(temporary, 'journal-format.txt'), '1\n');
  const identityFile = path.join(temporary, 'identity.json');
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  Object.assign(identity, {
    releaseId: legacyReleaseId,
    releaseVersion: legacyVersion,
    buildId: `sha256:${sourceSha}`,
    sourceSha256: sourceSha,
    releaseManifestSha256: sha256(path.join(legacyRelease, 'SHA256SUMS')),
    configId,
    journalFormat: 1,
  });
  writeFileSync(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
  const identitySha256 = sha256(identityFile);
  const legacyId = `d-${identitySha256.slice(0, 32)}`;
  writeFileSync(path.join(temporary, 'deployment.json'), `${JSON.stringify({
    deploymentId: legacyId,
    identitySha256,
    identity,
  }, null, 2)}\n`);
  rewriteManifest(temporary);
  renameSync(temporary, path.join(f.prefix, 'deployments', legacyId));
  unlinkSync(path.join(f.prefix, 'previous'));
  symlinkSync(`deployments/${legacyId}`, path.join(f.prefix, 'previous'));
}

function makeExternalNodeV1Previous(f, { rawControlPlane = false } = {}) {
  const oldTarget = readlinkSync(path.join(f.prefix, 'previous'));
  const oldDirectory = path.join(f.prefix, oldTarget);
  const temporary = path.join(f.prefix, 'deployments', `.external-v1-${process.pid}`);
  cpSync(oldDirectory, temporary, { recursive: true });
  makeTreeWritable(temporary);
  if (rawControlPlane) {
    assert.equal(rawV1ControlPlaneAvailable(), true, 'raw v1 control-plane snapshot changed or is unavailable');
    for (const relative of Object.keys(RAW_V1_CONTROL_PLANE_SHA256)) {
      cpSync(path.join(RAW_V1_CONTROL_PLANE, relative), path.join(temporary, relative));
    }
  }
  const identityFile = path.join(temporary, 'identity.json');
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  delete identity.nodeStorage;
  identity.nodeBin = f.nodeBin;
  for (const relative of Object.keys(identity.payloads)) {
    identity.payloads[relative] = sha256(path.join(temporary, relative));
  }
  writeFileSync(path.join(temporary, 'node-bin.txt'), `${f.nodeBin}\n`);
  writeFileSync(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
  const identitySha256 = sha256(identityFile);
  const deploymentId = `d-${identitySha256.slice(0, 32)}`;
  writeFileSync(path.join(temporary, 'deployment.json'), `${JSON.stringify({
    deploymentId,
    identitySha256,
    identity,
  }, null, 2)}\n`);
  rewriteManifest(temporary);
  const target = `deployments/${deploymentId}`;
  renameSync(temporary, path.join(f.prefix, target));
  unlinkSync(path.join(f.prefix, 'previous'));
  symlinkSync(target, path.join(f.prefix, 'previous'));
  return target;
}

function installRawV1StableRollback(f) {
  assert.equal(rawV1ControlPlaneAvailable(), true, 'raw v1 stable wrapper changed or is unavailable');
  const destination = path.join(f.prefix, 'bin', 'unity-mcp-router-rollback');
  cpSync(RAW_V1_STABLE_ROLLBACK, destination);
  chmodSync(destination, 0o700);
  assert.equal(sha256(destination), RAW_V1_STABLE_ROLLBACK_SHA256);
  return destination;
}

test('dry-run validates a pinned runtime and leaves the target untouched', (t) => {
  const f = fixture(t);
  const result = runShell(installArgs(f, f.source, ['--dry-run']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mode=dry-run/);
  assert.equal(existsSync(f.prefix), false);

  const bad = runShell([
    INSTALL, '--source', f.source, '--config', f.config, '--prefix', f.prefix,
    '--node-bin', process.execPath, '--node-sha256', '0'.repeat(64),
    '--launch-agents-dir', f.launchAgents, '--staging', '--dry-run',
  ]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /checksum mismatch/);
  assert.equal(existsSync(f.prefix), false);
});

test('dry-run and activation compute the same content-addressed deployment identity', (t) => {
  const f = fixture(t);
  const dry = runShell(installArgs(f, f.source, ['--dry-run']));
  assert.equal(dry.status, 0, dry.stderr);
  const dryDeployment = dry.stdout.match(/^deployment=(.+)$/m)?.[1];
  assert.match(dryDeployment, /^d-[a-f0-9]{32}$/);
  assert.equal(existsSync(f.prefix), false);

  const activated = runShell(installArgs(f));
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(activated.stdout.match(/^deployment=(.+)$/m)?.[1], dryDeployment);
  assert.equal(path.basename(readlinkSync(path.join(f.prefix, 'current'))), dryDeployment);
});

test('deployment identity changes with label, config, and deployment-script content', (t) => {
  const f = fixture(t);
  const deployment = (result) => result.stdout.match(/^deployment=(.+)$/m)?.[1];
  const baseline = runShell(installArgs(f, f.source, ['--dry-run']));
  assert.equal(baseline.status, 0, baseline.stderr);

  const relabeled = runShell(installArgs(f, f.source, [
    '--label', 'com.zamgune.unity-mcp-router.fixture', '--dry-run',
  ]));
  assert.equal(relabeled.status, 0, relabeled.stderr);
  assert.notEqual(deployment(relabeled), deployment(baseline));

  const config2 = path.join(f.base, 'router-variant.json');
  const configValue = JSON.parse(readFileSync(f.config, 'utf8'));
  configValue.toolTimeoutSec = 137;
  writeFileSync(config2, `${JSON.stringify(configValue, null, 2)}\n`);
  const configArgs = installArgs(f, f.source, ['--dry-run']);
  configArgs[configArgs.indexOf('--config') + 1] = config2;
  const reconfigured = runShell(configArgs);
  assert.equal(reconfigured.status, 0, reconfigured.stderr);
  assert.notEqual(deployment(reconfigured), deployment(baseline));

  const alternateInstaller = path.join(f.source, 'scripts', 'install-router.sh');
  const adapter = path.join(f.source, 'scripts', 'adapter-launcher.sh');
  writeFileSync(adapter, `${readFileSync(adapter, 'utf8')}\n# identity fixture\n`);
  const scriptArgs = installArgs(f, f.source, ['--dry-run']);
  scriptArgs[0] = alternateInstaller;
  const rescripted = runShell(scriptArgs);
  assert.equal(rescripted.status, 0, rescripted.stderr);
  assert.notEqual(deployment(rescripted), deployment(baseline));
  assert.equal(existsSync(f.prefix), false);
});

test('staged installs are immutable, allowlisted, atomic, backed up, and roll back in under five minutes', (t) => {
  const f = fixture(t);
  const clientConfig = path.join(f.base, 'claude.json');
  writeFileSync(clientConfig, '{"mcpServers":{}}\n');
  const first = runShell(installArgs(f, f.source, ['--client-config', clientConfig]));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /activated=staging/);

  const firstTarget = readlinkSync(path.join(f.prefix, 'current'));
  assert.match(firstTarget, /^deployments\//);
  assert.equal(existsSync(path.join(f.prefix, 'previous')), false);
  const firstDir = path.join(f.prefix, firstTarget);
  const releaseDir = releaseDirectory(f.prefix, firstDir);
  const installedPaths = manifestPaths(releaseDir);
  assert(installedPaths.includes('broker-daemon.mjs'));
  assert(installedPaths.includes('lib/admin-token.mjs'));
  assert(installedPaths.includes('lib/operation-journal.mjs'));
  assert(installedPaths.includes('lib/project-access-audit.mjs'));
  assert(!installedPaths.includes('README.md'));
  assert(!installedPaths.includes('rogue-secret.txt'));
  assert(installedPaths.includes('SOURCE_SHA256SUMS'));
  assert.equal(statSync(path.join(releaseDir, 'broker-daemon.mjs')).mode & 0o222, 0);
  assert.match(JSON.parse(readFileSync(path.join(releaseDir, 'release.json'), 'utf8')).buildId, /^sha256:[a-f0-9]{64}$/);
  const installedConfig = JSON.parse(readFileSync(path.join(firstDir, 'config.json'), 'utf8'));
  assert.equal(installedConfig.brokerMode, 'connect-only');
  assert.deepEqual(installedConfig.editorHandoff, {
    mode: 'manual-close',
    pollIntervalMs: 500,
    editorExitTimeoutSec: 180,
    startupTimeoutSec: 900,
  });
  assert.match(readFileSync(path.join(f.prefix, 'bin', 'unity-mcp-adapter'), 'utf8'), /adapter-launcher\.sh/);
  assert.equal(existsSync(path.join(firstDir, 'release')), false);
  assert.match(readFileSync(path.join(firstDir, 'launch-agent.plist'), 'utf8'), /current\/broker-launcher\.sh/);
  assert.match(readFileSync(path.join(firstDir, 'broker-launcher.sh'), 'utf8'), /checksum mismatch/);
  const identity = JSON.parse(readFileSync(path.join(firstDir, 'identity.json'), 'utf8'));
  assert.deepEqual(Object.keys(identity.payloads).sort(), [
    'adapter-launcher.sh', 'admin-launcher.sh', 'broker-admin.mjs', 'broker-launcher.sh',
    'config.json', 'deployment-audit.mjs', 'inspect-journal.mjs', 'install-state.mjs',
    'launch-agent.plist', 'rollback-launcher.sh', 'rollback-router.sh',
  ]);
  assert.equal(identity.nodeStorage, 'managed-content-addressed-v1');
  assert.equal(identity.nodeBin, path.join(f.prefix, 'runtimes', f.nodeSha, 'node'));
  assert.equal(identity.nodeSha256, f.nodeSha);
  assert.equal(identity.prefix, f.prefix);
  assert.equal(identity.launchAgentsDir, f.launchAgents);
  assert.equal(identity.installMode, 'staging');
  assert.equal(identity.label, 'com.zamgune.unity-mcp-router');
  for (const [relative, expected] of Object.entries(identity.payloads)) {
    assert.equal(sha256(path.join(firstDir, relative)), expected, relative);
  }
  const runtimeRoot = path.join(f.prefix, 'runtimes', f.nodeSha);
  const runtimeNode = path.join(runtimeRoot, 'node');
  assert.deepEqual(readdirSync(runtimeRoot), ['node']);
  assert.equal(sha256(runtimeNode), f.nodeSha);
  assert.equal(statSync(path.join(f.prefix, 'runtimes')).mode & 0o777, 0o700);
  assert.equal(statSync(runtimeRoot).mode & 0o777, 0o500);
  assert.equal(statSync(runtimeNode).mode & 0o777, 0o500);
  assert.equal(statSync(runtimeNode).nlink, 1);
  const backups = readdirSync(path.join(f.prefix, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(f.prefix, 'backups', backups[0], 'source-config.json'), 'utf8'), readFileSync(f.config, 'utf8'));
  assert.equal(readFileSync(path.join(f.prefix, 'backups', backups[0], 'client-1.config'), 'utf8'), readFileSync(clientConfig, 'utf8'));

  const identical = runShell(installArgs(f));
  assert.equal(identical.status, 0, identical.stderr);
  assert.match(identical.stdout, /activated=staging/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), firstTarget);

  const source2 = cloneReleaseSource(f, '2.0.1-fixture');
  const second = runShell(installArgs(f, source2));
  assert.equal(second.status, 0, second.stderr);
  const secondTarget = readlinkSync(path.join(f.prefix, 'current'));
  assert.notEqual(secondTarget, firstTarget);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), firstTarget);
  assert(!manifestPaths(releaseDirectory(f.prefix, path.join(f.prefix, secondTarget))).includes('rogue-secret.txt'));

  const started = Date.now();
  const rollback = runShell([
    path.join(f.prefix, 'bin', 'unity-mcp-router-rollback'),
  ]);
  const elapsed = Date.now() - started;
  assert.equal(rollback.status, 0, rollback.stderr);
  assert(elapsed < 300_000);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), firstTarget);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), secondTarget);
  assert.match(rollback.stdout, /elapsed_seconds=/);
});

test('new audit preserves v1 external-node metadata across bidirectional staging rollback', (t) => {
  const f = fixture(t);
  const firstInstall = runShell(installArgs(f));
  assert.equal(firstInstall.status, 0, firstInstall.stderr);
  const source2 = cloneReleaseSource(f, '2.0.1-managed-migration');
  const secondInstall = runShell(installArgs(f, source2));
  assert.equal(secondInstall.status, 0, secondInstall.stderr);
  const managedCurrent = readlinkSync(path.join(f.prefix, 'current'));
  const legacyPrevious = makeExternalNodeV1Previous(f);
  const legacyIdentity = JSON.parse(readFileSync(path.join(f.prefix, legacyPrevious, 'identity.json'), 'utf8'));
  assert.equal(legacyIdentity.nodeStorage, undefined);
  assert.equal(legacyIdentity.nodeBin, f.nodeBin);

  const toLegacy = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.equal(toLegacy.status, 0, toLegacy.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), legacyPrevious);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), managedCurrent);

  const toManaged = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.equal(toManaged.status, 0, toManaged.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), managedCurrent);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), legacyPrevious);
});

test('byte-exact installed raw-v1 control plane rolls forward to managed and remains rollback-compatible', {
  skip: !rawV1ControlPlaneAvailable(),
}, (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const source2 = cloneReleaseSource(f, '2.0.1-raw-v1-control-plane');
  const secondInstall = runShell(installArgs(f, source2));
  assert.equal(secondInstall.status, 0, secondInstall.stderr);
  const managedCurrent = readlinkSync(path.join(f.prefix, 'current'));
  const rawPrevious = makeExternalNodeV1Previous(f, { rawControlPlane: true });

  const toRaw = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.equal(toRaw.status, 0, toRaw.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawPrevious);
  for (const [relative, expected] of Object.entries(RAW_V1_CONTROL_PLANE_SHA256)) {
    assert.equal(sha256(path.join(f.prefix, rawPrevious, relative)), expected, relative);
  }

  // The post-migration stable wrapper owns the whole-operation guard even
  // while dispatching into the byte-exact raw-v1 rollback implementation.
  const guardedStableWrapper = path.join(f.prefix, 'bin', 'unity-mcp-router-rollback');
  const guardedToManaged = runShellWithEnv([guardedStableWrapper], {
    LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', TZ: 'Asia/Seoul', COLUMNS: '7',
  });
  assert.equal(guardedToManaged.status, 0, `${guardedToManaged.stderr}\n${guardedToManaged.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), managedCurrent);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), rawPrevious);
  const guardedBackToRaw = runShellWithEnv([guardedStableWrapper], {
    LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', TZ: 'Asia/Seoul', COLUMNS: '7',
  });
  assert.equal(guardedBackToRaw.status, 0, `${guardedBackToRaw.stderr}\n${guardedBackToRaw.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawPrevious);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), managedCurrent);

  const rawStableWrapper = installRawV1StableRollback(f);

  // The exact pre-migration stable wrapper dispatches through the raw-v1 launcher,
  // rollback script, deployment audit, and state helper copied above.
  const toManaged = runShellWithEnv([rawStableWrapper], {
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC', COLUMNS: '4096',
  });
  assert.equal(toManaged.status, 0, `${toManaged.stderr}\n${toManaged.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), managedCurrent);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), rawPrevious);

  const backToRaw = runShellWithEnv([rawStableWrapper], {
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC', COLUMNS: '4096',
  });
  assert.equal(backToRaw.status, 0, `${backToRaw.stderr}\n${backToRaw.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawPrevious);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), managedCurrent);
});

test('pre-migration raw-v1 wrapper fails closed on a live v2 installer lock under hostile locale', {
  skip: !rawV1ControlPlaneAvailable(),
}, async (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const source2 = cloneReleaseSource(f, '2.0.1-raw-v1-lock-owner');
  assert.equal(runShell(installArgs(f, source2)).status, 0);
  const rawCurrent = makeExternalNodeV1Previous(f, { rawControlPlane: true });
  const toRaw = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.equal(toRaw.status, 0, toRaw.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawCurrent);
  const rawStableWrapper = installRawV1StableRollback(f);

  const source3 = cloneReleaseSource(f, '2.0.2-raw-v1-lock-drift');
  const alternateInstaller = path.join(source3, 'scripts', 'install-router.sh');
  const args = installArgs(f, source3);
  args[0] = alternateInstaller;
  const ready = path.join(f.base, 'raw-v1-lock.ready');
  const pending = runShellAsync(args, {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'pause-after-drain',
    UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
  });
  t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));
  chmodSync(alternateInstaller, 0o700);
  writeFileSync(alternateInstaller, `${readFileSync(alternateInstaller, 'utf8')}\n# drift after v2 lock acquisition\n`);

  const lock = path.join(f.prefix, 'run', 'install.lock');
  const lockBytes = readFileSync(lock);
  assert.equal(JSON.parse(lockBytes).version, 2);
  const blockedHostile = runShellWithEnv([rawStableWrapper], {
    LANG: 'ko_KR.UTF-8',
    LC_ALL: 'ko_KR.UTF-8',
    TZ: 'Asia/Seoul',
    COLUMNS: '7',
  });
  assert.notEqual(blockedHostile.status, 0);
  assert.match(blockedHostile.stderr, /cannot parse process identity|install lock is corrupt and cannot be safely reclaimed/);
  assert.deepEqual(readFileSync(lock), lockBytes);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawCurrent);

  const blockedNormalized = runShellWithEnv([rawStableWrapper], {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    COLUMNS: '4096',
  });
  assert.notEqual(blockedNormalized.status, 0);
  assert.match(blockedNormalized.stderr, /install lock is corrupt and cannot be safely reclaimed/);
  assert.deepEqual(readFileSync(lock), lockBytes);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawCurrent);

  pending.child.kill('SIGTERM');
  const stopped = await pending.completed;
  assert.equal(stopped.status, 130, stopped.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawCurrent);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
});

test('new installer never reclaims a live raw-v1 rollback lock written in a different timezone', {
  skip: !rawV1ControlPlaneAvailable(),
}, async (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const source2 = cloneReleaseSource(f, '2.0.1-raw-v1-writer');
  assert.equal(runShell(installArgs(f, source2)).status, 0);
  const rawCurrent = makeExternalNodeV1Previous(f, { rawControlPlane: true });
  const toRaw = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.equal(toRaw.status, 0, toRaw.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), rawCurrent);
  const rawStableWrapper = installRawV1StableRollback(f);

  const ready = path.join(f.base, 'raw-v1-writer.ready');
  const pending = runShellAsync([rawStableWrapper], {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'pause-after-drain',
    UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'Asia/Seoul',
    COLUMNS: '4096',
  });
  t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));

  const lock = path.join(f.prefix, 'run', 'install.lock');
  const lockBytes = readFileSync(lock);
  assert.equal(JSON.parse(lockBytes).version, 1);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source3 = cloneReleaseSource(f, '2.0.2-new-reader-v1-owner');
  const blocked = runShellWithEnv(installArgs(f, source3), {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    COLUMNS: '4096',
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /legacy v1 install lock requires explicit offline recovery/);
  assert.deepEqual(readFileSync(lock), lockBytes);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);

  pending.child.kill('SIGTERM');
  const stopped = await pending.completed;
  assert.equal(stopped.status, 130, stopped.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
});

test('O_EXCL lock rejects a concurrent switch without changing current', (t) => {
  const f = fixture(t);
  const first = runShell(installArgs(f));
  assert.equal(first.status, 0, first.stderr);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.0.2-fixture');
  const invalidLock = 'other-installer\n';
  const lockFile = path.join(f.prefix, 'run', 'install.lock');
  writeFileSync(lockFile, invalidLock, { mode: 0o600 });
  const blocked = runShell(installArgs(f, source2));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /state file is not valid JSON/);
  assert.doesNotMatch(blocked.stderr, /SyntaxError|\bat readJson\b|Node\.js v/);
  assert.equal(readFileSync(lockFile, 'utf8'), invalidLock);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);

  unlinkSync(lockFile);
  const releaseFile = path.join(releaseDirectory(f.prefix, path.join(f.prefix, before)), 'broker-daemon.mjs');
  chmodSync(releaseFile, 0o600);
  writeFileSync(releaseFile, `${readFileSync(releaseFile, 'utf8')}\n// tampered\n`);
  const tampered = runShell(installArgs(f));
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /failed SHA verification/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);
});

test('managed directory symlinks are rejected before the install lock can escape', (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside');
  mkdirSync(f.prefix);
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.prefix, 'run'));
  const result = runShell(installArgs(f));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symlink/);
  assert.equal(existsSync(path.join(outside, 'install.lock')), false);
});

test('strict installed launchers reject overrides, admin mode, unknown flags, and duplicates', (t) => {
  const f = fixture(t);
  const installed = runShell(installArgs(f));
  assert.equal(installed.status, 0, installed.stderr);
  const commands = [
    ['unity-mcp-adapter', '--admin'],
    ['unity-mcp-adapter', '--config', f.config],
    ['unity-mcp-adapter', '--default', 'Game', '--default', 'Game'],
    ['unity-mcp-adapter', '--unknown'],
    ['unity-mcp-router-admin', 'status', '--config', f.config],
    ['unity-mcp-router-rollback', '--prefix', f.base],
    ['unity-mcp-router-rollback', '--verify-timeout-sec', '1', '--verify-timeout-sec', '1'],
  ];
  for (const [name, ...args] of commands) {
    const result = runShell([path.join(f.prefix, 'bin', name), ...args]);
    assert.equal(result.status, 64, `${name} ${args.join(' ')}\n${result.stderr}`);
  }
});

test('installer and all managed launchers clear Node and dynamic-loader injection variables', (t) => {
  const f = fixture(t);
  const marker = path.join(f.base, 'node-options.marker');
  const pathMarker = path.join(f.base, 'hostile-path.marker');
  const injection = path.join(f.base, 'node-options.cjs');
  const hostileBin = path.join(f.base, 'hostile-bin');
  mkdirSync(hostileBin);
  writeFileSync(injection, 'require("node:fs").writeFileSync(process.env.INJECTION_MARKER,"executed")\n');
  writeFileSync(path.join(hostileBin, 'dirname'),
    '#!/bin/sh\nprintf intercepted > "$HOSTILE_PATH_MARKER"\nexec /usr/bin/dirname "$@"\n',
    { mode: 0o700 });
  const hostile = {
    PATH: hostileBin,
    LANG: 'ko_KR.UTF-8',
    LC_ALL: 'ko_KR.UTF-8',
    TZ: 'Asia/Seoul',
    COLUMNS: '7',
    NODE_OPTIONS: `--require=${injection}`,
    NODE_PATH: f.base,
    OPENSSL_CONF: path.join(f.base, 'hostile-openssl.cnf'),
    OPENSSL_CONF_INCLUDE: f.base,
    OPENSSL_MODULES: f.base,
    OPENSSL_ENGINES: f.base,
    DYLD_INSERT_LIBRARIES: path.join(f.base, 'missing.dylib'),
    DYLD_LIBRARY_PATH: f.base,
    DYLD_FRAMEWORK_PATH: f.base,
    DYLD_FALLBACK_LIBRARY_PATH: f.base,
    DYLD_FALLBACK_FRAMEWORK_PATH: f.base,
    DYLD_VERSIONED_LIBRARY_PATH: f.base,
    DYLD_VERSIONED_FRAMEWORK_PATH: f.base,
    DYLD_ROOT_PATH: f.base,
    DYLD_IMAGE_SUFFIX: '_hostile',
    DYLD_SHARED_REGION: 'avoid',
    DYLD_SHARED_CACHE_DIR: f.base,
    LD_PRELOAD: path.join(f.base, 'missing.so'),
    LD_LIBRARY_PATH: f.base,
    LD_AUDIT: path.join(f.base, 'missing-audit.so'),
    INJECTION_MARKER: marker,
    HOSTILE_PATH_MARKER: pathMarker,
  };
  const installed = runShellWithEnv(installArgs(f), hostile);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(pathMarker), false);

  const nativeVariables = [
    'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES',
    'DYLD_SHARED_REGION', 'DYLD_SHARED_CACHE_DIR',
  ];
  const wrapperCommands = [
    ['unity-mcp-adapter', '--unknown'],
    ['unity-mcp-router-admin', 'status', '--config', f.config],
    ['unity-mcp-router-rollback', '--prefix', f.base],
  ];
  for (const [name, ...args] of wrapperCommands) {
    const wrapper = readFileSync(path.join(f.prefix, 'bin', name), 'utf8');
    assert.match(wrapper, /^#!\/bin\/sh\nset -eu\nunset /);
    assert.match(wrapper, /PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin\nexport PATH/);
    assert.match(wrapper, /LANG=C\nLC_ALL=C\nTZ=UTC\nCOLUMNS=4096\nexport LANG LC_ALL TZ COLUMNS/);
    assert.doesNotMatch(wrapper, /dirname/);
    for (const variable of nativeVariables) assert.match(wrapper, new RegExp(`\\b${variable}\\b`));
    if (name === 'unity-mcp-router-rollback') {
      assert.match(wrapper, /install-lock-cas\.guard/);
      assert.match(wrapper, /\/usr\/bin\/lockf -s -t 5 9/);
      assert.match(wrapper, new RegExp(`GUARD_NODE_SHA=${f.nodeSha}`));
      assert.match(wrapper, /fstatSync\(9\)/);
      assert.match(wrapper, /p\.dev!==f\.dev\|\|p\.ino!==f\.ino/);
      assert.match(wrapper, /managed guard Node checksum changed/);
    }

    const result = runShellWithEnv([path.join(f.prefix, 'bin', name), ...args], hostile, 5_000);
    assert.equal(result.status, 64, `${name} ${args.join(' ')}\n${result.stderr}`);
    assert.equal(existsSync(marker), false, name);
    assert.equal(existsSync(pathMarker), false, name);
  }

  const current = path.join(f.prefix, readlinkSync(path.join(f.prefix, 'current')));
  for (const [script, args, timeout] of [
    ['adapter-launcher.sh', [], 5_000],
    ['admin-launcher.sh', ['status', '--timeout-sec', '1'], 5_000],
    ['rollback-launcher.sh', [], 5_000],
    ['broker-launcher.sh', [], 1_500],
  ]) {
    runShellWithEnv([path.join(current, script), ...args], hostile, timeout);
    assert.equal(existsSync(marker), false, script);
    assert.equal(existsSync(pathMarker), false, script);
  }
});

test('pinned Node checksum is checked before the candidate executable can run', (t) => {
  const f = fixture(t);
  const marker = path.join(f.base, 'executed.marker');
  const fakeNode = path.join(f.base, 'fake-node');
  writeFileSync(fakeNode, `#!/bin/sh\nprintf executed > '${marker}'\nexit 99\n`, { mode: 0o700 });
  const result = runShell([
    INSTALL, '--source', f.source, '--config', f.config, '--prefix', f.prefix,
    '--node-bin', fakeNode, '--node-sha256', f.nodeSha,
    '--launch-agents-dir', f.launchAgents, '--staging', '--dry-run',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.prefix), false);
});

test('symlinked and hard-linked Node inputs fail closed before installation', (t) => {
  const f = fixture(t);
  const symlink = path.join(f.base, 'node-symlink');
  symlinkSync(f.nodeBin, symlink);
  const symlinked = runShell([
    INSTALL, '--source', f.source, '--config', f.config, '--prefix', f.prefix,
    '--node-bin', symlink, '--node-sha256', f.nodeSha,
    '--launch-agents-dir', f.launchAgents, '--staging', '--dry-run',
  ]);
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /must not be a symlink/);
  assert.equal(existsSync(f.prefix), false);

  const copied = path.join(f.base, 'node-copy');
  const hardlink = path.join(f.base, 'node-hardlink');
  cpSync(f.nodeBin, copied);
  chmodSync(copied, 0o700);
  linkSync(copied, hardlink);
  const linked = runShell([
    INSTALL, '--source', f.source, '--config', f.config, '--prefix', f.prefix,
    '--node-bin', hardlink, '--node-sha256', sha256(hardlink),
    '--launch-agents-dir', f.launchAgents, '--staging', '--dry-run',
  ]);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /must not be hard-linked/);
  assert.equal(existsSync(f.prefix), false);
});

test('a relocatability probe rejects a non-self-contained Node before target writes', {
  skip: process.platform !== 'darwin' || !existsSync(NON_SELF_CONTAINED_NODE) ||
    lstatSync(NON_SELF_CONTAINED_NODE).isSymbolicLink(),
}, (t) => {
  const f = fixture(t);
  const result = runShell([
    INSTALL, '--source', f.source, '--config', f.config, '--prefix', f.prefix,
    '--node-bin', NON_SELF_CONTAINED_NODE, '--node-sha256', sha256(NON_SELF_CONTAINED_NODE),
    '--launch-agents-dir', f.launchAgents, '--staging', '--dry-run',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-system dynamic dependencies/);
  assert.equal(existsSync(f.prefix), false);
});

test('managed runtime permission, symlink, and partial-copy tampering fail closed', (t) => {
  const f = fixture(t);
  const installed = runShell(installArgs(f));
  assert.equal(installed.status, 0, installed.stderr);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const runtime = path.join(f.prefix, 'runtimes', f.nodeSha);
  const node = path.join(runtime, 'node');
  chmodSync(runtime, 0o700);
  chmodSync(node, 0o700);
  const deployment = path.join(f.prefix, before);
  for (const [script, args] of [
    ['adapter-launcher.sh', []],
    ['admin-launcher.sh', ['status']],
    ['broker-launcher.sh', []],
    ['rollback-launcher.sh', []],
  ]) {
    const rejected = runShell([path.join(deployment, script), ...args]);
    assert.equal(rejected.status, 78, `${script}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /runtime directory verification failed|ownership, mode, or link count is unsafe/, script);
  }
  const stableRollbackRejected = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.equal(stableRollbackRejected.status, 1, stableRollbackRejected.stderr);
  assert.match(stableRollbackRejected.stderr, /managed guard runtime ownership or mode is unsafe/);
  const wrongMode = runShell(installArgs(f));
  assert.notEqual(wrongMode.status, 0);
  assert.match(wrongMode.stderr, /managed Node runtime failed exact|unsafe managed runtime/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);

  chmodSync(node, 0o500);
  chmodSync(runtime, 0o500);
  const f2 = fixture(t);
  mkdirSync(path.join(f2.prefix, 'runtimes'), { recursive: true, mode: 0o700 });
  const partial = path.join(f2.prefix, 'runtimes', f2.nodeSha);
  mkdirSync(partial, { mode: 0o500 });
  const incomplete = runShell(installArgs(f2));
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /managed Node runtime failed exact|file set mismatch/);

  const f3 = fixture(t);
  const outside = path.join(f3.base, 'outside-runtime');
  mkdirSync(path.join(f3.prefix, 'runtimes'), { recursive: true, mode: 0o700 });
  mkdirSync(outside);
  symlinkSync(outside, path.join(f3.prefix, 'runtimes', f3.nodeSha));
  const escaped = runShell(installArgs(f3));
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /not a real directory|managed Node runtime/);
});

test('dry-run config collision fails without changing source bytes, mode, or prefix', (t) => {
  const f = fixture(t);
  const raw = JSON.parse(readFileSync(f.config, 'utf8'));
  raw.logFile = raw.broker.journalFile;
  writeFileSync(f.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o640 });
  chmodSync(f.config, 0o640);
  const before = readFileSync(f.config);
  const beforeMode = statSync(f.config).mode & 0o777;
  const result = runShell(installArgs(f, f.source, ['--dry-run']));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config validation\/normalization failed/);
  assert.deepEqual(readFileSync(f.config), before);
  assert.equal(statSync(f.config).mode & 0o777, beforeMode);
  assert.equal(existsSync(f.prefix), false);
});

test('deployment link traversal and immutable release symlink retargets fail closed', (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const current = readlinkSync(path.join(f.prefix, 'current'));
  unlinkSync(path.join(f.prefix, 'current'));
  symlinkSync(`deployments/../deployments/${path.basename(current)}`, path.join(f.prefix, 'current'));
  const traversal = runShell(installArgs(f));
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /containment\/identity audit|unsafe deployment target/);

  unlinkSync(path.join(f.prefix, 'current'));
  symlinkSync(current, path.join(f.prefix, 'current'));
  const deployment = path.join(f.prefix, current);
  const releaseId = readFileSync(path.join(deployment, 'release-id.txt'), 'utf8').trim();
  const release = path.join(f.prefix, 'releases', releaseId);
  const saved = `${release}.saved`;
  renameSync(release, saved);
  symlinkSync(saved, release);
  const retarget = runShell(installArgs(f));
  assert.notEqual(retarget.status, 0);
  assert.match(retarget.stderr, /identity\/containment verification|real directory|not a directory|symlink/i);
});

test('live lock blocks a concurrent install and TERM restores the prior deployment', async (t) => {
  const f = fixture(t);
  const baseline = runShell(installArgs(f));
  assert.equal(baseline.status, 0, baseline.stderr);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.0-term-fixture');
  const ready = path.join(f.base, 'failpoint.ready');
  const pending = runShellAsync(installArgs(f, source2), {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'pause-after-current-link',
    UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
  });
  t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));
  const blocked = runShell(installArgs(f, source2));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /install\/rollback operation guard is busy/);
  const blockedRollback = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')]);
  assert.notEqual(blockedRollback.status, 0);
  assert.match(blockedRollback.stderr, /install\/rollback operation guard is busy/);
  pending.child.kill('SIGTERM');
  const stopped = await pending.completed;
  assert.equal(stopped.status, 130, stopped.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);
});

test('a live lock remains non-reclaimable when its installer script drifts', async (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.0-live-lock-drift');
  const alternateInstaller = path.join(source2, 'scripts', 'install-router.sh');
  const args = installArgs(f, source2);
  args[0] = alternateInstaller;
  const ready = path.join(f.base, 'lock-drift.ready');
  const pending = runShellAsync(args, {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'pause-after-current-link',
    UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
  });
  t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));
  chmodSync(alternateInstaller, 0o700);
  writeFileSync(alternateInstaller, `${readFileSync(alternateInstaller, 'utf8')}\n# drift after lock acquisition\n`);

  const blocked = runShell(installArgs(f, source2));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /install\/rollback operation guard is busy/);
  pending.child.kill('SIGTERM');
  const stopped = await pending.completed;
  assert.equal(stopped.status, 130, stopped.stderr);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);
});

test('lock release preserves an ABA-replaced foreign lock', async (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.0-lock-release-aba');
  const ready = path.join(f.base, 'lock-aba.ready');
  const pending = runShellAsync(installArgs(f, source2), {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'pause-after-current-link',
    UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
  });
  t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));

  const scriptSha = sha256(INSTALL);
  const foreign = spawnSync(f.nodeBin, [
    path.join(ROOT, 'scripts', 'install-state.mjs'), 'lock-payload',
    '--pid', String(process.pid), '--command-identity', `install:${scriptSha}`,
    '--script-path', INSTALL, '--script-sha256', scriptSha,
  ], { encoding: 'utf8' });
  assert.equal(foreign.status, 0, foreign.stderr);
  const lock = path.join(f.prefix, 'run', 'install.lock');
  writeFileSync(lock, foreign.stdout, { mode: 0o600 });
  pending.child.kill('SIGTERM');
  const stopped = await pending.completed;
  assert.equal(stopped.status, 130, stopped.stderr);
  assert.match(stopped.stderr, /foreign lock preserved/);
  assert.equal(readFileSync(lock, 'utf8'), foreign.stdout);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  unlinkSync(lock);
});

test('the disabled unguarded reclaim command preserves an ABA replacement', (t) => {
  const f = fixture(t);
  const run = path.join(f.prefix, 'run');
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const lock = path.join(run, 'install.lock');
  const scriptSha = sha256(INSTALL);
  const stale = {
    version: 2,
    lockId: 'a'.repeat(32),
    pid: 999999,
    processStartTime: 'Mon Jan 1 00:00:00 1990',
    processCommand: 'dead-installer',
    commandIdentity: `install:${scriptSha}`,
    scriptPath: INSTALL,
    scriptSha256: scriptSha,
    acquiredAt: new Date(0).toISOString(),
  };
  writeFileSync(lock, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  const helper = path.join(ROOT, 'scripts', 'install-state.mjs');
  const status = spawnSync(f.nodeBin, [helper, 'lock-status', '--file', lock], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.state, 'stale');
  assert.equal(snapshot.reclaimable, true);
  const replacement = `${JSON.stringify({ ...stale, acquiredAt: new Date(1).toISOString() })}\n`;
  writeFileSync(lock, replacement, { mode: 0o600 });
  const reclaimed = spawnSync(f.nodeBin, [
    helper, 'reclaim-lock', '--file', lock, '--destination', path.join(run, 'stale.json'),
    '--expected-lock-id', snapshot.lockId, '--expected-sha256', snapshot.lockSha256,
  ], { encoding: 'utf8' });
  assert.equal(reclaimed.status, 69, reclaimed.stderr);
  assert.match(reclaimed.stderr, /unguarded reclaim-lock is disabled/);
  assert.equal(readFileSync(lock, 'utf8'), replacement);
  assert.equal(existsSync(path.join(run, 'stale.json')), false);
});

test('HUP and INT also restore the prior deployment and clear durable transaction state', async (t) => {
  const f = fixture(t);
  const baseline = runShell(installArgs(f));
  assert.equal(baseline.status, 0, baseline.stderr);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.0-signal-fixture');
  const wrapperNames = ['unity-mcp-adapter', 'unity-mcp-router-admin', 'unity-mcp-router-rollback'];
  const wrapperBytes = new Map(wrapperNames.map((name) => [name, readFileSync(path.join(f.prefix, 'bin', name))]));
  for (const [signal, point] of [['SIGHUP', 'after-wrappers'], ['SIGINT', 'after-current-link']]) {
    const ready = path.join(f.base, `${signal}.ready`);
    const pending = runShellAsync(installArgs(f, source2), {
      UNITY_MCP_INSTALLER_TEST_MODE: '1',
      UNITY_MCP_INSTALLER_FAILPOINT: `pause-${point}`,
      UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
    });
    t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
    await waitUntil(() => existsSync(ready));
    pending.child.kill(signal);
    const stopped = await pending.completed;
    assert.equal(stopped.status, 130, `${signal}\n${stopped.stderr}`);
    assert.equal(readlinkSync(path.join(f.prefix, 'current')), before, signal);
    assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false, signal);
    assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false, signal);
    for (const name of wrapperNames) {
      assert.deepEqual(readFileSync(path.join(f.prefix, 'bin', name)), wrapperBytes.get(name), `${signal}:${name}`);
    }
  }
});

test('SIGKILL leaves durable evidence and the next invocation repairs then completes', async (t) => {
  const f = fixture(t);
  const baseline = runShell(installArgs(f));
  assert.equal(baseline.status, 0, baseline.stderr);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.1-kill-fixture');
  const ready = path.join(f.base, 'failpoint.ready');
  const pending = runShellAsync(installArgs(f, source2), {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'pause-after-current-link',
    UNITY_MCP_INSTALLER_FAILPOINT_READY: ready,
  });
  t.after(() => { if (pending.child.exitCode == null) pending.child.kill('SIGKILL'); });
  await waitUntil(() => existsSync(ready));
  pending.child.kill('SIGKILL');
  await pending.completed;
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), true);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), true);
  const crashedLock = JSON.parse(readFileSync(path.join(f.prefix, 'run', 'install.lock'), 'utf8'));
  assert.equal(crashedLock.version, 2);
  assert.match(crashedLock.lockId, /^[a-f0-9]{32}$/);

  const recovered = runShell(installArgs(f, source2));
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.notEqual(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);
  assert(readdirSync(path.join(f.prefix, 'run')).some((name) => name.startsWith('stale-install-lock-')));
});

test('rollback SIGKILL recovery does not double-toggle current and previous', (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const first = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.5-rollback-kill');
  assert.equal(runShell(installArgs(f, source2)).status, 0);
  const second = readlinkSync(path.join(f.prefix, 'current'));
  const wrapper = path.join(f.prefix, 'bin', 'unity-mcp-router-rollback');

  const crashed = runShellWithEnv([wrapper], {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'kill-after-current-link',
  });
  assert.equal(crashed.signal, 'SIGKILL', `${crashed.stderr}\n${crashed.stdout}`);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), true);
  const recovered = runShell([wrapper]);
  assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), first);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), second);

  const verifiedCrash = runShellWithEnv([wrapper], {
    UNITY_MCP_INSTALLER_TEST_MODE: '1',
    UNITY_MCP_INSTALLER_FAILPOINT: 'kill-after-verified',
  });
  assert.equal(verifiedCrash.signal, 'SIGKILL', `${verifiedCrash.stderr}\n${verifiedCrash.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), second);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), first);
  const finalized = runShell([wrapper]);
  assert.equal(finalized.status, 0, `${finalized.stderr}\n${finalized.stdout}`);
  assert.match(finalized.stdout, /rollback_recovery=finalized/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), second);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), first);
});

test('a PID-reuse-shaped stale lock is preserved and safely reclaimed', (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const source2 = cloneReleaseSource(f, '2.1.2-stale-fixture');
  const scriptSha = sha256(INSTALL);
  writeFileSync(path.join(f.prefix, 'run', 'install.lock'), `${JSON.stringify({
    version: 2,
    lockId: 'b'.repeat(32),
    pid: process.pid,
    processStartTime: 'Mon Jan 1 00:00:00 1990',
    processCommand: 'intentionally-reused-pid-fixture',
    commandIdentity: `install:${scriptSha}`,
    scriptPath: INSTALL,
    scriptSha256: scriptSha,
    acquiredAt: new Date(0).toISOString(),
  })}\n`, { mode: 0o600 });
  const result = runShell(installArgs(f, source2));
  assert.equal(result.status, 0, result.stderr);
  assert(readdirSync(path.join(f.prefix, 'run')).some((name) => name.startsWith('stale-install-lock-')));
});

test('a dead legacy-v1 lock blocks automatic migration and preserves exact evidence', (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.3-dead-v1-offline-recovery');
  const scriptSha = sha256(INSTALL);
  const lock = path.join(f.prefix, 'run', 'install.lock');
  const legacyBytes = `${JSON.stringify({
    version: 1,
    pid: 99999999,
    processStartTime: 'Mon Jan 1 00:00:00 1990',
    processCommand: 'dead-legacy-installer',
    commandIdentity: `install:${scriptSha}`,
    scriptPath: INSTALL,
    scriptSha256: scriptSha,
    acquiredAt: new Date(0).toISOString(),
  })}\n`;
  writeFileSync(lock, legacyBytes, { mode: 0o600 });

  const blocked = runShell(installArgs(f, source2));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /legacy v1 install lock requires explicit offline recovery/);
  assert.equal(readFileSync(lock, 'utf8'), legacyBytes);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(readdirSync(path.join(f.prefix, 'run')).some((name) => name.startsWith('stale-install-lock-')), false);
});

test('rollback to format 1 fails closed when a non-terminal v2 operation exists', (t) => {
  const f = fixture(t);
  assert.equal(runShell(installArgs(f)).status, 0);
  const source2 = cloneReleaseSource(f, '2.0.3-fixture');
  const second = runShell(installArgs(f, source2));
  assert.equal(second.status, 0, second.stderr);
  makeLegacyPrevious(f);
  const currentBefore = readlinkSync(path.join(f.prefix, 'current'));
  writeFileSync(path.join(f.state, 'operations.jsonl'), `${JSON.stringify({
    version: 2,
    operationId: 'still-running',
    project: 'Game',
    method: 'build',
    payloadSha256: 'a'.repeat(64),
    state: 'RECEIVED',
    at: new Date().toISOString(),
  })}\n`);

  const rollback = runShell([
    path.join(f.prefix, 'bin', 'unity-mcp-router-rollback'),
  ]);
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.stderr, /journalFormat 1 rollback blocked/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), currentBefore);
});

test('live activation uses only the injected launchctl and verifies the exact job PID/build/config', {
  skip: process.platform !== 'darwin',
}, (t) => {
  const f = liveFixture(t);
  const result = runShellWithEnv(liveInstallArgs(f), f.env);
  const diagnostics = [
    existsSync(f.launchctlState) ? readFileSync(f.launchctlState, 'utf8') : 'no fake launchctl state',
    existsSync(path.join(f.state, 'broker.log')) ? readFileSync(path.join(f.state, 'broker.log'), 'utf8') : 'no broker log',
  ].join('\n');
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${diagnostics}`);
  assert.match(result.stdout, /activated=live/);
  const state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  assert.equal(state.loaded, true);
  assert(Number.isSafeInteger(state.pid));
  assert(state.events.some((event) => event.event === 'bootstrap'));
  assert(state.events.some((event) => event.event === 'kickstart'));
  const status = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-admin'), 'status', '--timeout-sec', '5']);
  assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
  assert.equal(JSON.parse(status.stdout).result.broker.pid, state.pid);
});

test('candidate project access doctor failure restores the prior live deployment', {
  skip: process.platform !== 'darwin',
  timeout: 90_000,
}, (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const priorTarget = readlinkSync(path.join(f.prefix, 'current'));
  const priorPid = JSON.parse(readFileSync(f.launchctlState, 'utf8')).pid;

  const inaccessibleProject = path.join(f.base, 'NotAUnityProject');
  mkdirSync(inaccessibleProject);
  const blockedConfig = path.join(f.base, 'blocked-router.json');
  const configValue = JSON.parse(readFileSync(f.config, 'utf8'));
  configValue.projects = [{ name: 'Game', path: inaccessibleProject }];
  writeFileSync(blockedConfig, `${JSON.stringify(configValue, null, 2)}\n`);
  const source2 = cloneReleaseSource(f, '2.1.1-project-access-blocked');
  const args = liveInstallArgs(f, source2);
  args[args.indexOf('--config') + 1] = blockedConfig;

  const blocked = runShellWithEnv(args, f.env, 90_000);
  assert.notEqual(blocked.status, 0, `${blocked.stderr}\n${blocked.stdout}`);
  assert.match(blocked.stderr, /Managed Node .* cannot access every configured Unity project/);
  assert.match(blocked.stderr, /PROJECT_NOT_UNITY_PROJECT/);
  assert.match(blocked.stderr, /Removable Volumes/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), priorTarget);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  const restored = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  assert.equal(restored.loaded, true);
  assert(Number.isSafeInteger(restored.pid));
  assert.notEqual(restored.pid, priorPid);
  const status = runShell([path.join(f.prefix, 'bin', 'unity-mcp-router-admin'), 'status', '--timeout-sec', '5']);
  assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
  assert.equal(JSON.parse(status.stdout).result.broker.pid, restored.pid);
});

test('live upgrade waits for delayed launchctl bootout visibility before activating', {
  skip: process.platform !== 'darwin',
  timeout: 90_000,
}, (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const oldPid = JSON.parse(readFileSync(f.launchctlState, 'utf8')).pid;
  const source2 = cloneReleaseSource(f, '2.1.8-delayed-bootout');

  const startedAt = Date.now();
  const upgraded = runShellWithEnv(liveInstallArgs(f, source2), {
    ...f.env,
    FAKE_LAUNCHCTL_BOOTOUT_VISIBILITY_MS: '1200',
    FAKE_LAUNCHCTL_BOOTOUT_PROCESS_EXIT_MS: '1800',
  });
  const elapsedMs = Date.now() - startedAt;
  const diagnostics = existsSync(f.launchctlState)
    ? readFileSync(f.launchctlState, 'utf8') : 'no fake launchctl state';
  assert.equal(upgraded.status, 0, `${upgraded.stderr}\n${upgraded.stdout}\n${diagnostics}`);
  assert.match(upgraded.stdout, /activated=live/);
  assert(elapsedMs >= 1500, `installer did not wait for prior broker exit: ${elapsedMs}ms`);
  assert.equal(isFixtureBroker(oldPid, f.base), false, `prior broker PID ${oldPid} survived activation`);
  assert.notEqual(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);

  const state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  const bootoutIndex = state.events.findIndex((event) =>
    event.event === 'bootout' && event.visibilityMs === 1200);
  const staleIndex = state.events.findIndex((event, index) =>
    index > bootoutIndex && event.event === 'bootout-stale-print');
  const hiddenIndex = state.events.findIndex((event, index) =>
    index > staleIndex && event.event === 'bootout-hidden');
  const bootstrapIndex = state.events.findIndex((event, index) =>
    index > hiddenIndex && event.event === 'bootstrap');
  assert(bootoutIndex >= 0, diagnostics);
  assert(staleIndex > bootoutIndex, diagnostics);
  assert(hiddenIndex > staleIndex, diagnostics);
  assert(bootstrapIndex > hiddenIndex, diagnostics);
  assert.equal(state.loaded, true);
  assert(Number.isSafeInteger(state.pid));
});

test('live rollback waits for delayed bootout visibility and verifies the replacement launchd job', {
  skip: process.platform !== 'darwin',
  timeout: 90_000,
}, (t) => {
  const f = liveFixture(t);
  const firstInstall = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(firstInstall.status, 0, `${firstInstall.stderr}\n${firstInstall.stdout}`);
  const first = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.9-live-rollback');
  const secondInstall = runShellWithEnv(liveInstallArgs(f, source2), f.env);
  assert.equal(secondInstall.status, 0, `${secondInstall.stderr}\n${secondInstall.stdout}`);
  const second = readlinkSync(path.join(f.prefix, 'current'));
  assert.notEqual(second, first);

  const beforeRollbackState = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  const eventsBeforeRollback = beforeRollbackState.events.length;
  const oldPid = beforeRollbackState.pid;
  const startedAt = Date.now();
  const rollback = runShellWithEnv([path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')], {
    ...f.env,
    FAKE_LAUNCHCTL_BOOTOUT_VISIBILITY_MS: '1200',
    FAKE_LAUNCHCTL_BOOTOUT_PROCESS_EXIT_MS: '1800',
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(rollback.status, 0, `${rollback.stderr}\n${rollback.stdout}`);
  assert(elapsedMs >= 1500, `rollback did not wait for prior broker exit: ${elapsedMs}ms`);
  assert.equal(isFixtureBroker(oldPid, f.base), false, `prior broker PID ${oldPid} survived rollback`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), first);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), second);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  const state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  const rollbackEvents = state.events.slice(eventsBeforeRollback);
  const bootoutIndex = rollbackEvents.findIndex((event) =>
    event.event === 'bootout' && event.visibilityMs === 1200);
  const staleIndex = rollbackEvents.findIndex((event, index) =>
    index > bootoutIndex && event.event === 'bootout-stale-print');
  const hiddenIndex = rollbackEvents.findIndex((event, index) =>
    index > staleIndex && event.event === 'bootout-hidden');
  const bootstrapIndex = rollbackEvents.findIndex((event, index) =>
    index > hiddenIndex && event.event === 'bootstrap');
  assert(bootoutIndex >= 0, JSON.stringify(rollbackEvents));
  assert(staleIndex > bootoutIndex, JSON.stringify(rollbackEvents));
  assert(hiddenIndex > staleIndex, JSON.stringify(rollbackEvents));
  assert(bootstrapIndex > hiddenIndex, JSON.stringify(rollbackEvents));
  assert.equal(state.loaded, true);
  assert(Number.isSafeInteger(state.pid));
});

test('ambiguous launchctl print failures block install and rollback without switching state', {
  skip: process.platform !== 'darwin',
  timeout: 120_000,
}, (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const first = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.1.10-ambiguous-print');

  let state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  state.printFailuresRemaining = 1;
  writeFileSync(f.launchctlState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const blockedInstall = runShellWithEnv(liveInstallArgs(f, source2), f.env);
  assert.notEqual(blockedInstall.status, 0);
  assert.match(blockedInstall.stderr, /LaunchAgent state is unreadable/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), first);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);

  const upgraded = runShellWithEnv(liveInstallArgs(f, source2), f.env);
  assert.equal(upgraded.status, 0, `${upgraded.stderr}\n${upgraded.stdout}`);
  const second = readlinkSync(path.join(f.prefix, 'current'));
  assert.notEqual(second, first);

  state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  state.printFailuresRemaining = 1;
  writeFileSync(f.launchctlState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const rollbackCommand = [path.join(f.prefix, 'bin', 'unity-mcp-router-rollback')];
  const blockedRollback = runShellWithEnv(rollbackCommand, f.env);
  assert.notEqual(blockedRollback.status, 0);
  assert.match(blockedRollback.stderr, /LaunchAgent state is unreadable/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), second);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);

  const rolledBack = runShellWithEnv(rollbackCommand, f.env);
  assert.equal(rolledBack.status, 0, `${rolledBack.stderr}\n${rolledBack.stdout}`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), first);
  assert.equal(readlinkSync(path.join(f.prefix, 'previous')), second);
  state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  assert(state.events.filter((event) => event.event === 'print-failed-ambiguous').length >= 2);
});

test('after-bootstrap recovery waits for the candidate PID to exit before restoring and reinstalling', {
  skip: process.platform !== 'darwin',
  timeout: 120_000,
}, async (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const first = readlinkSync(path.join(f.prefix, 'current'));
  const firstPid = JSON.parse(readFileSync(f.launchctlState, 'utf8')).pid;
  const source2 = cloneReleaseSource(f, '2.1.11-after-bootstrap');

  const crashed = runShellWithEnv(liveInstallArgs(f, source2), {
    ...f.env,
    UNITY_MCP_INSTALLER_FAILPOINT: 'kill-after-bootstrap',
  });
  assert.equal(crashed.signal, 'SIGKILL', `${crashed.stderr}\n${crashed.stdout}`);
  const interruptedTarget = readlinkSync(path.join(f.prefix, 'current'));
  assert.notEqual(interruptedTarget, first);
  let state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  const candidatePid = state.pid;
  assert(Number.isSafeInteger(candidatePid));
  assert.notEqual(candidatePid, firstPid);
  await waitUntil(() => isFixtureBroker(candidatePid, f.base), 5_000);
  assert.equal(isFixtureBroker(candidatePid, f.base), true);
  const marker = JSON.parse(readFileSync(path.join(f.prefix, 'run', 'transaction.json'), 'utf8'));
  assert.equal(marker.phase, 'JOB_BOOTSTRAPPED');
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), true);
  const eventOffset = state.events.length;

  const startedAt = Date.now();
  const recovered = runShellWithEnv(liveInstallArgs(f, source2), {
    ...f.env,
    FAKE_LAUNCHCTL_BOOTOUT_VISIBILITY_MS: '1200',
    FAKE_LAUNCHCTL_BOOTOUT_PROCESS_EXIT_MS: '1800',
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
  assert(elapsedMs >= 3000, `recovery did not wait for both broker exits: ${elapsedMs}ms`);
  assert.equal(isFixtureBroker(candidatePid, f.base), false, `candidate PID ${candidatePid} survived recovery`);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), interruptedTarget);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false);

  state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  const recoveryEvents = state.events.slice(eventOffset);
  const candidateStop = recoveryEvents.findIndex((event) =>
    event.event === 'stop-scheduled' && event.pid === candidatePid && event.exitDelayMs === 1800);
  const restoreBootstrap = recoveryEvents.findIndex((event, index) =>
    index > candidateStop && event.event === 'bootstrap');
  assert(candidateStop >= 0, JSON.stringify(recoveryEvents));
  assert(restoreBootstrap > candidateStop, JSON.stringify(recoveryEvents));
  assert.equal(recoveryEvents.some((event) => event.event === 'start-blocked-by-stopping-pid'), false,
    JSON.stringify(recoveryEvents));
  assert.equal(state.loaded, true);
  assert(Number.isSafeInteger(state.pid));
  assert.notEqual(state.pid, candidatePid);
});

test('fake-launchctl live failpoints recover after drain, bootout, current, and plist mutations', {
  skip: process.platform !== 'darwin',
  timeout: 180_000,
}, (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  const baselineDiagnostics = [
    existsSync(f.launchctlState) ? readFileSync(f.launchctlState, 'utf8') : 'no fake launchctl state',
    existsSync(`${f.launchctlState}.child.stderr`) ? readFileSync(`${f.launchctlState}.child.stderr`, 'utf8') : 'no child stderr',
    existsSync(path.join(f.state, 'broker.log')) ? readFileSync(path.join(f.state, 'broker.log'), 'utf8') : 'no broker log',
  ].join('\n');
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}\n${baselineDiagnostics}`);
  const points = ['after-drain', 'after-bootout', 'after-current-link', 'after-plist'];
  for (const [index, point] of points.entries()) {
    const before = readlinkSync(path.join(f.prefix, 'current'));
    const source = cloneReleaseSource(f, `2.2.${index}-failpoint`);
    const crashed = runShellWithEnv(liveInstallArgs(f, source), {
      ...f.env,
      UNITY_MCP_INSTALLER_FAILPOINT: `kill-${point}`,
    });
    assert.equal(crashed.signal, 'SIGKILL', `${point}\n${crashed.stderr}\n${crashed.stdout}`);
    assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), true, point);
    assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), true, point);

    const recovered = runShellWithEnv(liveInstallArgs(f, source), f.env);
    assert.equal(recovered.status, 0, `${point}\n${recovered.stderr}\n${recovered.stdout}`);
    assert.notEqual(readlinkSync(path.join(f.prefix, 'current')), before, point);
    assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false, point);
    assert.equal(existsSync(path.join(f.prefix, 'run', 'install.lock')), false, point);
    const state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
    assert.equal(state.loaded, true, point);
    assert(Number.isSafeInteger(state.pid), point);
  }
  const state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  assert(state.events.filter((event) => event.event === 'bootout').length >= 4);
  assert(state.events.filter((event) => event.event === 'bootstrap').length >= 5);
});

test('loaded-but-dead broker is repaired only with quiescent durable state', {
  skip: process.platform !== 'darwin',
  timeout: 90_000,
}, async (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const firstState = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  process.kill(firstState.pid, 'SIGKILL');
  await waitUntil(() => {
    try { process.kill(firstState.pid, 0); return false; } catch { return true; }
  });

  const repaired = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(repaired.status, 0, `${repaired.stderr}\n${repaired.stdout}`);
  const repairedState = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  assert.equal(repairedState.loaded, true);
  assert.notEqual(repairedState.pid, firstState.pid);

  process.kill(repairedState.pid, 'SIGKILL');
  await waitUntil(() => {
    try { process.kill(repairedState.pid, 0); return false; } catch { return true; }
  });
  writeFileSync(path.join(f.state, 'operations.jsonl'), `${JSON.stringify({
    version: 2,
    operationId: 'loaded-dead-active',
    project: 'Game',
    method: 'build',
    state: 'RECEIVED',
    at: new Date().toISOString(),
  })}\n`);
  const blocked = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /loaded-but-dead broker has nonterminal operations/);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
});

test('a reachable manual broker is never classified as the launchd job', {
  skip: process.platform !== 'darwin',
  timeout: 90_000,
}, async (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const domain = `gui/${process.getuid()}/${f.label}`;
  const bootout = spawnSync(f.fakeLaunchctl, ['bootout', domain], {
    env: { ...process.env, ...f.env },
    encoding: 'utf8',
  });
  assert.equal(bootout.status, 0, bootout.stderr);
  const current = readlinkSync(path.join(f.prefix, 'current'));
  const launcher = path.join(f.prefix, current, 'broker-launcher.sh');
  const manual = spawn('/bin/sh', [launcher], {
    env: { ...process.env, ...f.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  f.ownBrokerPid(manual.pid);
  let manualError = '';
  manual.stderr.setEncoding('utf8');
  manual.stderr.on('data', (chunk) => { manualError += chunk; });
  const socket = JSON.parse(readFileSync(f.config, 'utf8')).broker.socketPath;
  await waitUntil(() => existsSync(socket) || manual.exitCode != null);
  assert.equal(manual.exitCode, null, manualError);

  const blocked = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /reachable broker is not owned by the LaunchAgent/);
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), current);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
});

test('restore bootstrap failure is surfaced and retained for a later safe retry', {
  skip: process.platform !== 'darwin',
  timeout: 90_000,
}, (t) => {
  const f = liveFixture(t);
  const baseline = runShellWithEnv(liveInstallArgs(f), f.env);
  assert.equal(baseline.status, 0, `${baseline.stderr}\n${baseline.stdout}`);
  const before = readlinkSync(path.join(f.prefix, 'current'));
  const source2 = cloneReleaseSource(f, '2.3.0-restore-failure');
  const crashed = runShellWithEnv(liveInstallArgs(f, source2), {
    ...f.env,
    UNITY_MCP_INSTALLER_FAILPOINT: 'kill-after-current-link',
  });
  assert.equal(crashed.signal, 'SIGKILL', `${crashed.stderr}\n${crashed.stdout}`);
  const state = JSON.parse(readFileSync(f.launchctlState, 'utf8'));
  state.failBootstrapCount = 1;
  writeFileSync(f.launchctlState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const failedRestore = runShellWithEnv(liveInstallArgs(f, source2), f.env);
  assert.notEqual(failedRestore.status, 0);
  assert.match(failedRestore.stderr, /could not be safely recovered/);
  const marker = JSON.parse(readFileSync(path.join(f.prefix, 'run', 'transaction.json'), 'utf8'));
  assert.equal(marker.phase, 'RESTORE_FAILED');
  assert.equal(readlinkSync(path.join(f.prefix, 'current')), before);

  const retried = runShellWithEnv(liveInstallArgs(f, source2), f.env);
  assert.equal(retried.status, 0, `${retried.stderr}\n${retried.stdout}`);
  assert.notEqual(readlinkSync(path.join(f.prefix, 'current')), before);
  assert.equal(existsSync(path.join(f.prefix, 'run', 'transaction.json')), false);
});
