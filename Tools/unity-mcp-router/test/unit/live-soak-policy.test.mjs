import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import test from 'node:test';

import {
  CLIENT_NAMES,
  DEFAULT_DURATION_SEC,
  SoakPolicyError,
  assertBaselineProjectChildren,
  assertFingerprintStable,
  assertNotificationAllowlist,
  assertRouterSnapshot,
  assertScheduleDrift,
  buildSoakPlan,
  buildSoakSchedule,
  captureGitDirtyFingerprint,
  openEvidenceFile,
  parseSoakArgs,
  runSoak,
  validateNewEvidencePath,
} from '../../scripts/live-soak.mjs';

function options(overrides = {}) {
  return {
    project: 'a',
    projectPath: '/project/a',
    evidence: '/private/tmp/live-soak-evidence.jsonl',
    adapter: '/router/unity-mcp-adapter',
    durationSec: 1,
    requestTimeoutSec: 1,
    operationTimeoutSec: 1,
    settleMs: 1,
    maxOutputBytes: 1_000_000,
    withReload: true,
    withRestart: true,
    fairnessBurst: 2,
    dryRun: false,
    help: false,
    ...overrides,
  };
}

function toolResponse(value, { isError = false } = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError,
      content: [{ type: 'text', text: isError ? 'redacted fake failure' : 'ok' }],
      structuredContent: value,
    },
  };
}

function catalogResponse(tools) {
  return { jsonrpc: '2.0', id: 1, result: { tools } };
}

const TOOLS = Object.freeze([
  { name: 'editor_status', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'recompile',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' }, focus: { type: 'boolean' } } },
  },
  { name: 'recompile_status', inputSchema: { type: 'object', properties: {} } },
  { name: 'unity_router_doctor', inputSchema: { type: 'object', properties: {} } },
  { name: 'unity_router_operation_status', inputSchema: { type: 'object', properties: {} } },
  { name: 'unity_router_status', inputSchema: { type: 'object', properties: {} } },
]);

function projectEntry({ name, alias, projectPath, childPid, toolsFingerprint, childState = 'READY' }) {
  return {
    name,
    aliases: [alias],
    path: projectPath,
    child: {
      pid: childPid,
      state: childState,
      alive: childState !== 'OFFLINE',
      ready: childState === 'READY',
    },
    scheduler: {
      pending: 0,
      queued: 0,
      activeOperationId: null,
      activeClientId: null,
    },
    tools: toolsFingerprint,
    mutationFence: [],
    backgroundOperation: null,
    deliveryPending: [],
  };
}

function cleanStatus({
  clients = 2,
  childPid = 402,
  otherChildPid = 450,
  editorPid = 501,
  pendingTotal = 0,
  activeHeavy = 0,
  otherChildActive = true,
} = {}) {
  return {
    broker: {
      pid: 401,
      buildId: 'build-1',
      configHash: 'config-1',
      draining: false,
      clients,
    },
    unity: { version: '1.0.0-beta.3', supported: true },
    budget: { pendingTotal, activeHeavy },
    leases: [],
    workspaceLeases: [],
    workspaceStore: { ok: true },
    unknownOutcomes: [],
    recoveryFaults: [],
    processAudit: {
      ok: true,
      editors: [{ pid: editorPid, projectPath: '/project/a' }],
    },
    projectAccess: { ok: true, projects: [] },
    projects: [
      projectEntry({
        name: 'Project A', alias: 'a', projectPath: '/project/a', childPid,
        toolsFingerprint: 'tool-fingerprint-1',
      }),
      projectEntry({
        name: 'Project B', alias: 'b', projectPath: '/project/b', childPid: otherChildPid,
        toolsFingerprint: 'tool-fingerprint-2',
        childState: otherChildActive ? 'READY' : 'OFFLINE',
      }),
    ],
  };
}

function cleanDoctor(editorPid = 501) {
  return {
    ok: true,
    editors: [{ pid: editorPid, projectPath: '/project/a' }],
    processAudit: { ok: true },
    projectAccess: { ok: true },
  };
}

function expectedIdentity(overrides = {}) {
  return {
    project: 'a',
    projectPath: '/project/a',
    brokerPid: 401,
    childPid: 402,
    buildId: 'build-1',
    configHash: 'config-1',
    toolsFingerprint: 'tool-fingerprint-1',
    editorPid: 501,
    projectChildren: [
      {
        name: 'Project A', path: '/project/a', pid: 402, alive: true, ready: true,
        state: 'READY', toolsFingerprint: 'tool-fingerprint-1',
      },
      {
        name: 'Project B', path: '/project/b', pid: 450, alive: true, ready: true,
        state: 'READY', toolsFingerprint: 'tool-fingerprint-2',
      },
    ],
    ...overrides,
  };
}

function fingerprint(digest = 'dirty-1') {
  return {
    algorithm: 'unity-mcp-router-dirty-v1',
    digest,
    head: 'abc123',
    headRef: 'refs/heads/main',
    dirty: true,
    statusBytes: 17,
    untrackedCount: 1,
    untrackedBytes: 3,
    projectPath: '/project/a',
    gitRoot: '/project/a',
  };
}

function gitFixture(root, args) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

test('argument policy defaults to a 60-minute guarded run and counts opt-in mutations', () => {
  assert.throws(() => parseSoakArgs([]), /--project is required/);
  assert.throws(() => parseSoakArgs([
    '--project', 'a', '--project-path', 'relative', '--evidence', '/tmp/e',
  ]), /project-path.*absolute/);
  assert.throws(() => parseSoakArgs([
    '--project', 'a', '--project-path', '/project/a', '--evidence', '/tmp/e', '--duration-sec', '3599',
  ]), /between 3600 and 21600/);
  assert.throws(() => parseSoakArgs([
    '--project', 'a', '--project-path', '/project/a', '--evidence', '/tmp/e', '--fairness-burst', '3',
  ]), /must be even/);
  assert.throws(() => parseSoakArgs([
    '--project', 'a', '--project', 'b', '--project-path', '/project/a', '--evidence', '/tmp/e',
  ]), /only once/);

  const parsed = parseSoakArgs([
    '--project', 'a',
    '--project-path', '/project/a',
    '--evidence', '/private/tmp/evidence.jsonl',
    '--with-reload',
    '--with-restart',
    '--fairness-burst', '6',
    '--dry-run',
  ]);
  assert.equal(parsed.durationSec, DEFAULT_DURATION_SEC);
  assert.equal(parsed.withReload, true);
  assert.equal(parsed.withRestart, true);
  assert.equal(parsed.fairnessBurst, 6);
  const plan = buildSoakPlan(parsed);
  assert.equal(plan.expectedJsonlSnapshots, 13);
  assert.equal(plan.expectedSimultaneousReadRounds, 61);
  assert.equal(plan.maximumPeriodicDispatchDriftSec, 30);
  assert.deepEqual(plan.mutationDispatches, {
    reload: 1,
    fairnessNoopRecompile: 6,
    controlledChildRestart: 1,
  });
  assert.equal(plan.totalUnityMutationDispatches, 7);
  assert.equal(plan.totalAdministrativeMutationDispatches, 1);
  assert.equal(plan.mutationRetries, 0);
});

test('schedule keeps every optional action inside the run and preserves same-time ordering', () => {
  const schedule = buildSoakSchedule(options(), {
    safeReadIntervalMs: 100,
    snapshotIntervalMs: 300,
    reloadAtMs: 200,
    reconnectAtMs: 400,
    restartAtMs: 600,
    fairnessAtMs: 800,
  });
  assert.equal(schedule.at(-1).kind, 'final');
  assert.equal(schedule.at(-1).atMs, 1_000);
  assert.deepEqual(
    schedule.filter((entry) => entry.atMs === 600).map((entry) => entry.kind),
    ['safe-read', 'snapshot', 'restart'],
  );
  assert.throws(() => buildSoakSchedule(options(), { reconnectAtMs: 1_000 }), /inside the soak duration/);
});

test('periodic dispatch drift is bounded and overdue work is never accepted as backfill', () => {
  assert.equal(assertScheduleDrift('safe-read', 100, 125, 25), 25);
  assert.equal(assertScheduleDrift('snapshot', 100, 90, 0), 0);
  assert.throws(
    () => assertScheduleDrift('safe-read', 100, 126, 25),
    (error) => error instanceof SoakPolicyError && error.code === 'PERIODIC_DISPATCH_MISSED',
  );
});

test('evidence creation is exclusive, mode 0600, symlink-safe, and rejects secret-shaped records', (t) => {
  const root = mkdtempSync('/private/tmp/unity-live-soak-policy-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidencePath = `${root}/evidence.jsonl`;
  assert.equal(validateNewEvidencePath(evidencePath), evidencePath);
  const writer = openEvidenceFile(evidencePath);
  writer.append({ type: 'safe', brokerPid: 1 });
  assert.throws(() => writer.append({ authorization: 'Bearer abcdefghijk' }), /forbidden/);
  writer.close();
  assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
  assert.match(readFileSync(evidencePath, 'utf8'), /"brokerPid":1/);
  assert.throws(() => openEvidenceFile(evidencePath), /already exists/);

  const target = `${root}/target`;
  const linked = `${root}/linked.jsonl`;
  writeFileSync(target, 'x');
  symlinkSync(target, linked);
  assert.throws(() => validateNewEvidencePath(linked), /already exists/);
});

test('snapshot and notification gates fail on route, PID, queue, unknown, or method drift', () => {
  const expected = expectedIdentity();
  assert.equal(assertRouterSnapshot(cleanStatus(), expected).path, '/project/a');
  for (const mutate of [
    (value) => { value.broker.pid = 999; },
    (value) => { value.projects[0].path = '/project/b'; },
    (value) => { value.projects[0].child.pid = 999; },
    (value) => { value.projects[1].child.pid = 999; },
    (value) => { value.projects[1].child.state = 'OFFLINE'; },
    (value) => { value.projects[1].tools = 'changed-catalog'; },
    (value) => { value.budget.pendingTotal = 1; },
    (value) => { value.unknownOutcomes.push({ state: 'UNKNOWN_OUTCOME' }); },
    (value) => { value.recoveryFaults.push({ code: 'FAULT' }); },
    (value) => { value.processAudit.editors[0].pid = 502; },
    (value) => { value.processAudit.editors.push({ pid: 503, projectPath: '/project/b' }); },
  ]) {
    const invalid = structuredClone(cleanStatus());
    mutate(invalid);
    assert.throws(() => assertRouterSnapshot(invalid, expected), SoakPolicyError);
  }
  assert.equal(assertNotificationAllowlist(['notifications/tools/list_changed']), true);
  assert.throws(() => assertNotificationAllowlist(['notifications/message']), /forbidden notification method/);
});

test('baseline requires the target READY and every non-target configured child OFFLINE', () => {
  const clean = cleanStatus({ otherChildPid: null, otherChildActive: false });
  assert.equal(assertBaselineProjectChildren(clean, 'a').path, '/project/a');

  const targetBusy = structuredClone(clean);
  targetBusy.projects[0].child.state = 'BUSY';
  assert.throws(
    () => assertBaselineProjectChildren(targetBusy, 'a'),
    (error) => error instanceof SoakPolicyError && error.code === 'TARGET_CHILD_NOT_READY_AT_BASELINE',
  );

  assert.throws(
    () => assertBaselineProjectChildren(cleanStatus(), 'a'),
    (error) => error instanceof SoakPolicyError && error.code === 'NON_TARGET_CHILD_ACTIVE_AT_BASELINE',
  );
});

test('fingerprint comparison preserves a dirty baseline exactly and fails closed on any drift', () => {
  assert.equal(assertFingerprintStable(fingerprint(), fingerprint()), true);
  assert.throws(() => assertFingerprintStable(fingerprint(), fingerprint('dirty-2')), /fingerprint changed/);
  assert.throws(() => assertFingerprintStable(fingerprint(), { ...fingerprint(), gitRoot: '/other' }), /fingerprint changed/);
  assert.throws(() => assertFingerprintStable(fingerprint(), { ...fingerprint(), headRef: 'refs/heads/other' }), /fingerprint changed/);
});

test('Git fingerprint binds branch, index/worktree layers, and untracked file mode', async (t) => {
  const root = mkdtempSync('/private/tmp/unity-live-soak-git-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  gitFixture(root, ['init']);
  gitFixture(root, ['config', 'user.name', 'Soak Test']);
  gitFixture(root, ['config', 'user.email', 'soak@example.invalid']);
  writeFileSync(`${root}/tracked.txt`, 'base\n');
  gitFixture(root, ['add', 'tracked.txt']);
  gitFixture(root, ['commit', '-m', 'baseline']);
  gitFixture(root, ['branch', '-M', 'main']);

  const onMain = await captureGitDirtyFingerprint(root);
  gitFixture(root, ['checkout', '-b', 'same-commit']);
  const onOtherBranch = await captureGitDirtyFingerprint(root);
  assert.equal(onMain.head, onOtherBranch.head);
  assert.equal(onMain.headRef, 'refs/heads/main');
  assert.equal(onOtherBranch.headRef, 'refs/heads/same-commit');
  assert.notEqual(onMain.digest, onOtherBranch.digest);

  writeFileSync(`${root}/tracked.txt`, 'staged-one\n');
  gitFixture(root, ['add', 'tracked.txt']);
  writeFileSync(`${root}/tracked.txt`, 'same-worktree\n');
  const firstIndex = await captureGitDirtyFingerprint(root);
  writeFileSync(`${root}/tracked.txt`, 'staged-two\n');
  gitFixture(root, ['add', 'tracked.txt']);
  writeFileSync(`${root}/tracked.txt`, 'same-worktree\n');
  const secondIndex = await captureGitDirtyFingerprint(root);
  assert.notEqual(firstIndex.digest, secondIndex.digest);

  gitFixture(root, ['add', 'tracked.txt']);
  gitFixture(root, ['commit', '-m', 'index baseline']);
  const worktreeA = await captureGitDirtyFingerprint(root);
  writeFileSync(`${root}/tracked.txt`, 'worktree-only\n');
  const worktreeB = await captureGitDirtyFingerprint(root);
  assert.notEqual(worktreeA.digest, worktreeB.digest);

  writeFileSync(`${root}/untracked.txt`, 'same-untracked-bytes\n', { mode: 0o644 });
  const untrackedModeA = await captureGitDirtyFingerprint(root);
  chmodSync(`${root}/untracked.txt`, 0o755);
  const untrackedModeB = await captureGitDirtyFingerprint(root);
  assert.notEqual(untrackedModeA.digest, untrackedModeB.digest);

  writeFileSync(`${root}/race.txt`, 'race-a\n');
  await assert.rejects(
    captureGitDirtyFingerprint(root, {
      fingerprintCheckpoint: async (checkpoint) => {
        if (checkpoint === 'after-first-untracked-manifest') writeFileSync(`${root}/race.txt`, 'race-b\n');
      },
    }),
    (error) => error instanceof SoakPolicyError && error.code === 'FINGERPRINT_RACE',
  );
});

test('dry-run fingerprints and prints the exact plan without clients, evidence creation, or mutation', async () => {
  let clients = 0;
  let evidence = 0;
  let stdout = '';
  const parsed = parseSoakArgs([
    '--project', 'a', '--project-path', '/project/a', '--evidence', '/private/tmp/new-evidence.jsonl', '--dry-run',
  ]);
  const result = await runSoak(parsed, {
    validateEvidencePath: () => true,
    captureFingerprint: async () => fingerprint(),
    clientFactory: () => { clients += 1; throw new Error('must not connect'); },
    evidenceFactory: () => { evidence += 1; throw new Error('must not create evidence'); },
    io: { stdout: { write: (value) => { stdout += value; } }, stderr: { write() {} } },
  });
  assert.equal(result.kind, 'dry-run');
  assert.equal(clients, 0);
  assert.equal(evidence, 0);
  assert.match(stdout, /"totalUnityMutationDispatches": 0/);
  assert.match(stdout, /"mutationRetries": 0/);
});

function createFakeHarness({
  forceReloadDelayMs = 0,
  lateCloseNotification = null,
  nonTargetActiveAtBaseline = false,
  rejectFairnessIndex = null,
  restartAllChildren = false,
  spuriousRestartListChanged = false,
} = {}) {
  let now = 0;
  let childPid = 402;
  let otherChildPid = nonTargetActiveAtBaseline ? 450 : null;
  const active = new Set();
  const createdNames = [];
  const calls = [];
  const closes = [];
  const evidenceRecords = [];
  let adminRestarts = 0;
  let evidenceCloseCount = 0;
  let fingerprintCaptures = 0;
  let noopDispatches = 0;
  const pendingFairness = [];
  let stdout = '';

  class FakeClient {
    constructor(name) {
      this.name = name;
      this.instanceIndex = createdNames.length;
      this.notifications = [];
      this.closed = false;
      createdNames.push(name);
      active.add(this);
    }

    async initialize(deadlineAt) {
      assert.equal(Number.isFinite(deadlineAt), true);
      return {
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
        },
      };
    }

    async request(method, params, { deadlineAt } = {}) {
      assert.equal(Number.isFinite(deadlineAt), true);
      calls.push({
        client: this.name,
        instanceIndex: this.instanceIndex,
        method,
        tool: params?.name ?? null,
        arguments: params?.arguments ?? null,
        deadlineAt,
        dispatchedAt: now,
      });
      if (method === 'tools/list') return catalogResponse(TOOLS);
      if (method !== 'tools/call') throw new Error(`unsupported fake method ${method}`);
      const name = params.name;
      if (name === 'editor_status') return toolResponse({
        status: 'ready',
        compiling: false,
        domainReloadInProgress: false,
        playMode: 'stopped',
        projectPath: '/project/a',
        unityVersion: '6000.3.17f1',
      });
      if (name === 'unity_router_status') return toolResponse(cleanStatus({
        clients: active.size,
        childPid,
        otherChildPid,
        otherChildActive: nonTargetActiveAtBaseline,
        pendingTotal: pendingFairness.length,
        activeHeavy: pendingFairness.length > 0 ? 1 : 0,
      }));
      if (name === 'unity_router_doctor') return toolResponse(cleanDoctor());
      if (name === 'unity_router_operation_status') return toolResponse({
        operationId: params.arguments.operationId,
        method: 'recompile',
        state: 'COMPLETED',
      });
      if (name === 'recompile_status') return toolResponse({
        status: 'up_to_date', failed: false, errors: [], isCompiling: false,
      });
      if (name === 'recompile' && params.arguments.force === true) {
        for (const client of active) client.notifications.push({ method: 'notifications/tools/list_changed' });
        now += forceReloadDelayMs;
        return toolResponse({
          status: 'completed',
          failed: false,
          errors: [],
          isCompiling: false,
          routerOperationState: 'COMPLETED',
          routerOperationId: 'reload-sync',
          routerDeliveryAckRequired: true,
        });
      }
      if (name === 'recompile') {
        const dispatchIndex = noopDispatches++;
        const response = toolResponse({
          status: 'up_to_date',
          routerOperationState: 'COMPLETED',
          routerOperationId: `noop-${dispatchIndex + 1}`,
          routerDeliveryAckRequired: true,
        });
        return new Promise((resolve, reject) => {
          pendingFairness.push({
            at: now + 40 * (dispatchIndex + 1),
            settle: () => {
              if (dispatchIndex === rejectFairnessIndex) reject(new Error('injected fairness failure'));
              else resolve(response);
            },
          });
        });
      }
      throw new Error(`unsupported fake tool ${name}`);
    }

    async close({ requireGraceful = false } = {}) {
      if (this.closed) return { code: 0, signal: null };
      this.closed = true;
      active.delete(this);
      closes.push({ client: this.name, instanceIndex: this.instanceIndex, requireGraceful });
      if (this.instanceIndex === 1 && lateCloseNotification != null) {
        this.notifications.push({ method: lateCloseNotification });
      }
      return { code: 0, signal: null };
    }
  }

  const timing = {
    safeReadIntervalMs: 100,
    snapshotIntervalMs: 300,
    reloadAtMs: 200,
    reconnectAtMs: 400,
    restartAtMs: 600,
    fairnessAtMs: 800,
    maxScheduleDriftMs: 25,
  };
  const runtime = {
    timing,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        const due = pendingFairness.filter((entry) => entry.at <= now);
        for (const entry of due) pendingFairness.splice(pendingFairness.indexOf(entry), 1);
        for (const entry of due) entry.settle();
        await Promise.resolve();
        await Promise.resolve();
      },
    },
    validateEvidencePath: () => true,
    evidenceFactory: () => ({
      path: '/private/tmp/live-soak-evidence.jsonl',
      append: (record) => evidenceRecords.push(record),
      close: () => { evidenceCloseCount += 1; },
    }),
    captureFingerprint: async () => {
      fingerprintCaptures += 1;
      return fingerprint();
    },
    clientFactory: (name) => new FakeClient(name),
    adminRestart: async ({ deadlineAt }) => {
      assert.equal(Number.isFinite(deadlineAt), true);
      adminRestarts += 1;
      childPid += 1;
      if (restartAllChildren) otherChildPid = otherChildPid == null ? 451 : otherChildPid + 1;
      if (spuriousRestartListChanged) {
        for (const client of active) client.notifications.push({ method: 'notifications/tools/list_changed' });
      }
    },
    io: { stdout: { write: (value) => { stdout += value; } }, stderr: { write() {} } },
  };
  const telemetry = {
    active,
    calls,
    closes,
    createdNames,
    evidenceRecords,
    get adminRestarts() { return adminRestarts; },
    get childPid() { return childPid; },
    get evidenceCloseCount() { return evidenceCloseCount; },
    get fingerprintCaptures() { return fingerprintCaptures; },
    get now() { return now; },
    get otherChildPid() { return otherChildPid; },
    get stdout() { return stdout; },
  };
  return { runtime, telemetry, timing };
}

test('active non-target baseline fails before safe reads or mutations and closes cleanly', async () => {
  const fake = createFakeHarness({ nonTargetActiveAtBaseline: true });
  await assert.rejects(
    runSoak(options(), fake.runtime),
    (error) => error instanceof SoakPolicyError && error.code === 'NON_TARGET_CHILD_ACTIVE_AT_BASELINE',
  );

  assert.deepEqual(
    fake.telemetry.calls.filter((entry) => entry.method === 'tools/call').map((entry) => entry.tool),
    ['unity_router_status'],
  );
  assert.equal(fake.telemetry.adminRestarts, 0);
  assert.equal(fake.telemetry.now, 0);
  assert.equal(fake.telemetry.active.size, 0);
  assert.equal(fake.telemetry.closes.length, 2);
  assert.equal(fake.telemetry.fingerprintCaptures, 2);
  assert.equal(fake.telemetry.evidenceCloseCount, 1);
  assert.equal(fake.telemetry.evidenceRecords.some((entry) => entry.type === 'safe_read_round'), false);
  assert.deepEqual(fake.telemetry.evidenceRecords.at(-1).mutationDispatches, {
    reload: 0,
    restart: 0,
    fairness: 0,
  });
  assert.equal(fake.telemetry.evidenceRecords.at(-1).error.code, 'NON_TARGET_CHILD_ACTIVE_AT_BASELINE');
  assert.equal(fake.telemetry.evidenceRecords.at(-1).dirtyUnchanged, true);
});

test('injected clock/runtime completes the full two-client lifecycle without real time or Unity', async () => {
  const fake = createFakeHarness();
  const soakOptions = options();
  const result = await runSoak(soakOptions, fake.runtime);

  assert.equal(result.ok, true);
  assert.equal(result.reconnects, 1);
  assert.deepEqual(result.mutationDispatches, { reload: 1, restart: 1, fairness: 2 });
  assert.equal(result.mutationRetries, 0);
  assert.equal(result.dirtyUnchanged, true);
  assert.equal(result.brokerPid, 401);
  assert.equal(result.childPid, 403);
  assert.equal(result.editorPid, 501);
  assert.equal(result.editorUnityVersion, '6000.3.17f1');
  assert.deepEqual(result.notificationCounts, { codexListChanged: 1, claudeListChanged: 1 });
  assert.equal(fake.telemetry.adminRestarts, 1);
  assert.equal(fake.telemetry.fingerprintCaptures, 2);
  assert.equal(fake.telemetry.active.size, 0);
  assert.deepEqual(fake.telemetry.createdNames, [CLIENT_NAMES.codex, CLIENT_NAMES.claude, CLIENT_NAMES.claude]);
  assert.equal(fake.telemetry.closes.filter((entry) => entry.requireGraceful).length, 3);
  assert.equal(fake.telemetry.calls.filter(
    (entry) => entry.tool === 'recompile' && entry.arguments?.force === true,
  ).length, 1);
  assert.equal(fake.telemetry.calls.filter(
    (entry) => entry.tool === 'recompile' && entry.arguments?.force !== true,
  ).length, 2);
  assert(fake.telemetry.calls.every((entry) => Number.isFinite(entry.deadlineAt)));
  assert(fake.telemetry.evidenceRecords.some((entry) => entry.type === 'reconnect_complete'));
  assert.equal(
    fake.telemetry.evidenceRecords.filter((entry) => entry.type === 'snapshot').length,
    buildSoakPlan(soakOptions, fake.timing).expectedJsonlSnapshots,
  );
  const fairness = fake.telemetry.evidenceRecords.find(
    (entry) => entry.type === 'operation_complete' && entry.operation === 'fairness_noop_burst',
  );
  assert(fairness.monitoringSamples >= 2);
  assert.equal(fairness.maxActiveHeavyObserved, 1);
  assert.equal(fairness.completionOrder.length, 2);
  assert.equal(fake.telemetry.evidenceRecords.at(-1).ok, true);
  assert.match(fake.telemetry.stdout, /"cleanCloseout": true/);
});

test('byte-identical controlled restart accepts exactly zero list_changed notifications', async () => {
  const fake = createFakeHarness();
  const result = await runSoak(
    options({ withReload: false, fairnessBurst: 0 }),
    fake.runtime,
  );

  assert.equal(result.ok, true);
  assert.equal(fake.telemetry.adminRestarts, 1);
  assert.deepEqual(result.notificationCounts, { codexListChanged: 0, claudeListChanged: 0 });
  assert.deepEqual(fake.telemetry.evidenceRecords.at(-1).notificationCounts, {
    codexListChanged: 0,
    claudeListChanged: 0,
  });
});

test('spurious controlled-restart list_changed fails and records only safe notification counts', async () => {
  const fake = createFakeHarness({ spuriousRestartListChanged: true });
  await assert.rejects(
    runSoak(options({ withReload: false, fairnessBurst: 0 }), fake.runtime),
    (error) => error instanceof SoakPolicyError && error.code === 'LIST_CHANGED_COUNT_DRIFT',
  );

  const final = fake.telemetry.evidenceRecords.at(-1);
  assert.equal(final.error.code, 'LIST_CHANGED_COUNT_DRIFT');
  assert.deepEqual(final.mutationDispatches, { reload: 0, restart: 1, fairness: 0 });
  assert.deepEqual(final.notificationCounts, { codexListChanged: 1, claudeListChanged: 1 });
  assert.equal(fake.telemetry.active.size, 0);
  assert.equal(fake.telemetry.evidenceCloseCount, 1);
});

test('one opt-in reload has one end-to-end deadline and is never retried after overrun', async () => {
  const fake = createFakeHarness({ forceReloadDelayMs: 1_001 });
  const soakOptions = options({ withRestart: false, fairnessBurst: 0 });
  await assert.rejects(
    runSoak(soakOptions, fake.runtime),
    (error) => error instanceof SoakPolicyError && error.code === 'REQUEST_DEADLINE_EXCEEDED',
  );
  assert.equal(fake.telemetry.calls.filter(
    (entry) => entry.tool === 'recompile' && entry.arguments?.force === true,
  ).length, 1);
  assert.equal(fake.telemetry.evidenceRecords.at(-1).mutationDispatches.reload, 1);
  assert.equal(fake.telemetry.evidenceRecords.at(-1).mutationRetries, 0);
});

test('an overdue lifecycle action fails cadence instead of backfilling periodic reads', async () => {
  const fake = createFakeHarness({ forceReloadDelayMs: 150 });
  const soakOptions = options({ withRestart: false, fairnessBurst: 0 });
  await assert.rejects(
    runSoak(soakOptions, fake.runtime),
    (error) => error instanceof SoakPolicyError && error.code === 'PERIODIC_DISPATCH_MISSED',
  );
  assert.equal(fake.telemetry.calls.filter(
    (entry) => entry.tool === 'recompile' && entry.arguments?.force === true,
  ).length, 1);
  assert.equal(fake.telemetry.evidenceRecords.some(
    (entry) => entry.type === 'safe_read_round' && entry.label === 'periodic-0.3s',
  ), false);
});

test('reconnect drains and validates notifications that arrive during graceful close', async (t) => {
  for (const scenario of [
    { method: 'notifications/message', code: 'FORBIDDEN_NOTIFICATION' },
    { method: 'notifications/tools/list_changed', code: 'LIST_CHANGED_COUNT_DRIFT' },
  ]) {
    await t.test(scenario.code, async () => {
      const fake = createFakeHarness({ lateCloseNotification: scenario.method });
      const soakOptions = options({ withReload: false, withRestart: false, fairnessBurst: 0 });
      let observed;
      await assert.rejects(runSoak(soakOptions, fake.runtime), (error) => {
        observed = error;
        return error instanceof SoakPolicyError && error.code === scenario.code;
      });
      assert.equal(observed.message.includes(scenario.method), false);
      assert.deepEqual(fake.telemetry.createdNames, [CLIENT_NAMES.codex, CLIENT_NAMES.claude]);
      assert.equal(fake.telemetry.closes[0].requireGraceful, true);
    });
  }
});

test('controlled restart rejects any non-target configured project child replacement', async () => {
  const fake = createFakeHarness({ restartAllChildren: true });
  const soakOptions = options({ withReload: false, fairnessBurst: 0 });
  await assert.rejects(
    runSoak(soakOptions, fake.runtime),
    (error) => error instanceof SoakPolicyError && error.code === 'PROJECT_CHILD_PID_DRIFT',
  );
  assert.equal(fake.telemetry.adminRestarts, 1);
  assert.equal(fake.telemetry.evidenceRecords.at(-1).mutationDispatches.restart, 1);
  assert.equal(fake.telemetry.otherChildPid, 451);
});

test('fairness burst joins every mutation rejection without retry or unhandled rejection', async () => {
  const fake = createFakeHarness({ rejectFairnessIndex: 1 });
  const soakOptions = options({ withReload: false, withRestart: false });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      runSoak(soakOptions, fake.runtime),
      (error) => error instanceof SoakPolicyError && error.code === 'FAIRNESS_DISPATCH_FAILED',
    );
    await Promise.resolve();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(fake.telemetry.calls.filter(
    (entry) => entry.tool === 'recompile' && entry.arguments?.force !== true,
  ).length, 2);
  assert.equal(fake.telemetry.evidenceRecords.at(-1).mutationDispatches.fairness, 2);
  assert.equal(fake.telemetry.evidenceRecords.at(-1).mutationRetries, 0);
  assert.deepEqual(unhandled, []);
});
