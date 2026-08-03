import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EDITOR_HANDOFF_STATES,
  EditorLifecycle,
} from '../../lib/editor-lifecycle.mjs';
import { OperationJournal } from '../../lib/operation-journal.mjs';

const PROJECT_A = Object.freeze({ name: 'A', key: 'project-a', path: '/projects/A' });
const PROJECT_B = Object.freeze({ name: 'B', key: 'project-b', path: '/projects/B' });
const OLD_EDITOR = Object.freeze({ pid: 101, projectPath: PROJECT_A.path });
const TARGET_EDITOR = Object.freeze({ pid: 202, projectPath: PROJECT_B.path });

async function fixture(t, {
  mode = 'manual-close',
  processAudit = async () => ({ ok: true, editors: [] }),
  projectAccess = async () => ({ ok: true }),
  callTool = async () => ({ status: 'ready', projectPath: PROJECT_B.path, playMode: 'stopped' }),
  stopChild = async () => {},
  openProject = async () => {},
  brokerIdle = async () => true,
  switchAllowed = async () => true,
  onStateChange = () => {},
  operationId = undefined,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))),
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'editor-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await OperationJournal.open(path.join(root, 'operations.jsonl'));
  const config = {
    projects: [PROJECT_A, PROJECT_B],
    toolTimeoutSec: 1,
    editorHandoff: {
      mode,
      pollIntervalMs: 1,
      editorExitTimeoutSec: 0.1,
      startupTimeoutSec: 0.1,
      pipelineTimeoutSec: 0.1,
    },
  };
  const lifecycle = new EditorLifecycle({
    config,
    journal,
    processAudit,
    projectAccess,
    callTool,
    stopChild,
    openProject,
    brokerIdle,
    switchAllowed,
    onStateChange,
    ...(operationId ? { operationId } : {}),
    delay,
    logger: { error() {}, warn() {} },
  });
  t.after(async () => {
    await lifecycle.close();
    await journal.close();
  });
  await lifecycle.ready();
  return { lifecycle, journal, config };
}

async function waitForState(lifecycle, operationId, expected, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = lifecycle.status(operationId);
    if (snapshot?.state === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${expected}; current=${lifecycle.status(operationId)?.state}`);
}

test('target already ready completes without close, stop, or open side effects', async (t) => {
  const sideEffects = [];
  const stateChanges = [];
  const { lifecycle, journal } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [TARGET_EDITOR] }),
    callTool: async (project, name) => {
      assert.equal(project.key, PROJECT_B.key);
      assert.equal(name, 'zamgune_handoff_status');
      return { ready: true, projectPath: PROJECT_B.path, playMode: 'stopped' };
    },
    stopChild: async () => sideEffects.push('stop'),
    openProject: async () => sideEffects.push('open'),
    onStateChange: (snapshot) => stateChanges.push(snapshot),
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  assert.match(queued.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(queued.state, EDITOR_HANDOFF_STATES.QUEUED);
  const completed = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.COMPLETED);

  assert.equal(completed.target.projectKey, PROJECT_B.key);
  assert.deepEqual(sideEffects, []);
  assert.equal(journal.get(queued.operationId).state, 'COMPLETED');
  assert.equal(lifecycle.activeStatus(), null);
  assert.equal(stateChanges.filter((snapshot) => snapshot.state === EDITOR_HANDOFF_STATES.COMPLETED).length, 1);
  assert(Object.isFrozen(stateChanges.at(-1)));
});

test('an exact missing-tool code for the expected lifecycle tool falls back to editor_status', async (t) => {
  const calls = [];
  const sideEffects = [];
  const { lifecycle, journal } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [TARGET_EDITOR] }),
    callTool: async (_project, name) => {
      calls.push(name);
      if (name === 'zamgune_handoff_status') {
        const error = new Error('catalog-proven missing lifecycle tool');
        error.code = 'TOOL_NOT_FOUND';
        error.toolName = name;
        throw error;
      }
      assert.equal(name, 'editor_status');
      return { ready: true, projectPath: PROJECT_B.path, playMode: 'stopped' };
    },
    stopChild: async () => sideEffects.push('stop'),
    openProject: async () => sideEffects.push('open'),
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const completed = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.COMPLETED);

  assert.deepEqual(calls, ['zamgune_handoff_status', 'editor_status']);
  assert.deepEqual(sideEffects, []);
  assert.equal(completed.oldEditor, null);
  assert.equal(journal.get(queued.operationId).state, 'COMPLETED');
});

test('a domain not-found error is not mistaken for an unavailable lifecycle tool', async (t) => {
  const calls = [];
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [TARGET_EDITOR] }),
    callTool: async (_project, name) => {
      calls.push(name);
      const error = new Error('Tool dependency not found while reading Editor state');
      error.code = 'EDITOR_LIFECYCLE_TOOL_ERROR';
      throw error;
    },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const failed = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.FAILED);

  assert.deepEqual(failed.blockers, ['PIPELINE_READY_TIMEOUT']);
  assert(calls.length > 0);
  assert(calls.every((name) => name === 'zamgune_handoff_status'));
});

test('state callback observes immutable transitions and one terminal notification', async (t) => {
  const changes = [];
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [TARGET_EDITOR] }),
    onStateChange: (snapshot) => changes.push(snapshot),
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.COMPLETED);

  assert(changes.some((snapshot) => snapshot.state === EDITOR_HANDOFF_STATES.PRECHECK));
  assert.equal(changes.filter((snapshot) => snapshot.state === EDITOR_HANDOFF_STATES.COMPLETED).length, 1);
  assert(changes.every(Object.isFrozen));
});

test('malformed readiness without exact project identity or explicit state fails closed', async (t) => {
  const changes = [];
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [TARGET_EDITOR] }),
    callTool: async () => ({}),
    onStateChange: (snapshot) => changes.push(snapshot),
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const failed = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.FAILED);

  assert.deepEqual(failed.blockers, ['PIPELINE_READY_TIMEOUT']);
  assert(changes.some((snapshot) => snapshot.blockers.includes('PIPELINE_PROJECT_IDENTITY_MISSING')));
  assert(changes.some((snapshot) => snapshot.blockers.includes('PIPELINE_NOT_READY')));
  assert(changes.some((snapshot) => snapshot.blockers.includes('PLAY_MODE_ACTIVE')));
});

test('failed process audit blocks Editor open even when it reports zero Editors', async (t) => {
  let openCount = 0;
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({
      ok: false,
      findings: [{ severity: 'error', kind: 'duplicate_broker' }],
      editors: [],
    }),
    openProject: async () => { openCount += 1; },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const blocked = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.BLOCKED);

  assert.equal(openCount, 0);
  assert.deepEqual(blocked.blockers, ['PROCESS_AUDIT_UNSAFE', 'DUPLICATE_BROKER']);
});

test('error process-audit findings block Editor open even when ok is inconsistently true', async (t) => {
  let openCount = 0;
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({
      ok: true,
      findings: [{ severity: 'error', kind: 'duplicate_broker' }],
      editors: [],
    }),
    openProject: async () => { openCount += 1; },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const blocked = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.BLOCKED);

  assert.equal(openCount, 0);
  assert.deepEqual(blocked.blockers, ['PROCESS_AUDIT_UNSAFE', 'DUPLICATE_BROKER']);
});

test('missing process-audit Editor identity blocks Editor open', async (t) => {
  let openCount = 0;
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({ ok: true, findings: [] }),
    openProject: async () => { openCount += 1; },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const blocked = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.BLOCKED);

  assert.equal(openCount, 0);
  assert.deepEqual(blocked.blockers, ['PROCESS_AUDIT_UNSAFE']);
});

test('shutdown waits for an in-flight audit and forbids a later Editor open', async (t) => {
  let resolveAudit;
  let markAuditStarted;
  const auditResult = new Promise((resolve) => { resolveAudit = resolve; });
  const auditStarted = new Promise((resolve) => { markAuditStarted = resolve; });
  let openCount = 0;
  const { lifecycle, journal } = await fixture(t, {
    processAudit: async () => {
      markAuditStarted();
      return auditResult;
    },
    openProject: async () => { openCount += 1; },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  await auditStarted;
  const closing = lifecycle.close();
  resolveAudit({ ok: true, findings: [], editors: [] });
  await closing;

  assert.equal(openCount, 0);
  assert.equal(journal.get(queued.operationId).state, 'QUEUED');
});

test('shutdown waits for an ensureProject still recording before job registration', async (t) => {
  let releaseRecord;
  let markRecordStarted;
  const recordGate = new Promise((resolve) => { releaseRecord = resolve; });
  const recordStarted = new Promise((resolve) => { markRecordStarted = resolve; });
  let openCount = 0;
  const { lifecycle, journal } = await fixture(t, {
    openProject: async () => { openCount += 1; },
  });
  const recordReceived = journal.recordReceived.bind(journal);
  journal.recordReceived = async (input) => {
    markRecordStarted();
    await recordGate;
    return recordReceived(input);
  };

  let ensureSettled = false;
  const ensuring = lifecycle.ensureProject(PROJECT_B).then((snapshot) => {
    ensureSettled = true;
    return snapshot;
  });
  await recordStarted;
  let closeSettled = false;
  const closing = lifecycle.close().then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const closeSettledBeforeRecord = closeSettled;
  releaseRecord();

  const queued = await ensuring;
  await closing;

  assert.equal(closeSettledBeforeRecord, false);
  assert.equal(ensureSettled, true);
  assert.equal(openCount, 0);
  assert.equal(lifecycle.status(queued.operationId).state, EDITOR_HANDOFF_STATES.QUEUED);
  assert.equal(journal.get(queued.operationId).state, 'QUEUED');
  await assert.rejects(() => lifecycle.ensureProject(PROJECT_B), { code: 'EDITOR_LIFECYCLE_CLOSED' });
});

test('manual close waits for the exact old PID, opens once, and waits for target readiness', async (t) => {
  let phase = 'old';
  let delayCount = 0;
  let openCount = 0;
  let stopCount = 0;
  const events = [];
  const audit = async () => {
    if (phase === 'old') return { ok: true, editors: [OLD_EDITOR] };
    if (phase === 'none') {
      events.push('old-pid-absent');
      return { ok: true, editors: [] };
    }
    return { ok: true, editors: [TARGET_EDITOR] };
  };
  const { lifecycle, journal } = await fixture(t, {
    processAudit: audit,
    delay: async () => {
      delayCount += 1;
      if (delayCount === 1) phase = 'none';
    },
    stopChild: async (project) => {
      assert.equal(project.key, PROJECT_A.key);
      stopCount += 1;
    },
    openProject: async (project) => {
      assert.equal(project.key, PROJECT_B.key);
      events.push('open');
      openCount += 1;
      phase = 'target';
    },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.COMPLETED);

  assert.equal(openCount, 1);
  assert.equal(stopCount, 1);
  assert(events.indexOf('old-pid-absent') >= 0);
  assert(events.indexOf('old-pid-absent') < events.indexOf('open'), 'old PID must disappear before open dispatch');
  assert.equal(journal.get(`${queued.operationId}:open`).state, 'COMPLETED');
});

test('typed handoff blocks on dirty or playing status and performs no side effect', async (t) => {
  const toolCalls = [];
  let openCount = 0;
  const { lifecycle, journal } = await fixture(t, {
    mode: 'typed-auto-close',
    processAudit: async () => ({ ok: true, editors: [OLD_EDITOR] }),
    callTool: async (project, name) => {
      toolCalls.push({ project, name });
      return {
        canClose: false,
        blockers: ['DIRTY_SCENE', 'PLAY_MODE_ACTIVE'],
        projectPath: OLD_EDITOR.projectPath,
        currentPid: OLD_EDITOR.pid,
      };
    },
    openProject: async () => { openCount += 1; },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const blocked = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.BLOCKED);

  assert.deepEqual(blocked.blockers, ['DIRTY_SCENE', 'PLAY_MODE_ACTIVE']);
  assert.deepEqual(toolCalls.map((call) => call.name), ['zamgune_handoff_status']);
  assert.equal(openCount, 0);
  assert.equal(journal.get(queued.operationId).state, 'CANCELLED');
});

test('typed close delivery uncertainty is terminal and close is never retried', async (t) => {
  let closeCount = 0;
  let openCount = 0;
  const { lifecycle, journal } = await fixture(t, {
    mode: 'typed-auto-close',
    processAudit: async () => ({ ok: true, editors: [OLD_EDITOR] }),
    callTool: async (project, name) => {
      if (name === 'zamgune_handoff_status') return {
        canClose: true,
        blockers: [],
        projectPath: OLD_EDITOR.projectPath,
        currentPid: OLD_EDITOR.pid,
      };
      if (name === 'zamgune_editor_close') {
        closeCount += 1;
        const error = new Error('connection dropped after dispatch');
        error.code = 'DELIVERY_UNKNOWN';
        throw error;
      }
      throw new Error(`unexpected tool ${name}`);
    },
    openProject: async () => { openCount += 1; },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const unknown = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(closeCount, 1);
  assert.equal(openCount, 0);
  assert.deepEqual(unknown.blockers, ['DELIVERY_UNKNOWN']);
  assert.equal(journal.get(queued.operationId).state, 'UNKNOWN_OUTCOME');
});

test('open delivery uncertainty is terminal and open is never retried', async (t) => {
  let openCount = 0;
  const { lifecycle, journal } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [] }),
    openProject: async () => {
      openCount += 1;
      const error = new Error('launcher result unknown');
      error.code = 'OPEN_UNKNOWN';
      throw error;
    },
  });

  const queued = await lifecycle.ensureProject(PROJECT_B);
  const unknown = await waitForState(lifecycle, queued.operationId, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(openCount, 1);
  assert.deepEqual(unknown.blockers, ['OPEN_UNKNOWN']);
  assert.equal(journal.get(queued.operationId).state, 'UNKNOWN_OUTCOME');
  assert.equal(journal.get(`${queued.operationId}:open`).state, 'UNKNOWN_OUTCOME');
});

test('unresolved parent or open UNKNOWN_OUTCOME globally fences handoff until admin resolution', async (t) => {
  let sequence = 0;
  let failOpen = true;
  let activePath = null;
  const { lifecycle, journal } = await fixture(t, {
    operationId: () => `editor-use-fence-${++sequence}`,
    processAudit: async () => ({
      ok: true,
      editors: activePath ? [{ pid: 303, projectPath: activePath }] : [],
    }),
    callTool: async (project) => ({ ready: true, projectPath: project.path, playMode: 'stopped' }),
    openProject: async (project) => {
      if (failOpen) {
        const error = new Error('unknown launcher result');
        error.code = 'OPEN_UNKNOWN';
        throw error;
      }
      activePath = project.path;
    },
  });

  const first = await lifecycle.ensureProject(PROJECT_B);
  await waitForState(lifecycle, first.operationId, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME);
  await assert.rejects(() => lifecycle.ensureProject(PROJECT_A), {
    code: 'EDITOR_HANDOFF_UNKNOWN_OUTCOME',
  });

  await journal.markResolved(first.operationId, 'abandoned');
  assert.equal(lifecycle.status(first.operationId).state, EDITOR_HANDOFF_STATES.CANCELLED);
  assert.deepEqual(lifecycle.status(first.operationId).blockers, ['ADMIN_RESOLVED']);
  await assert.rejects(() => lifecycle.ensureProject(PROJECT_A), {
    code: 'EDITOR_HANDOFF_UNKNOWN_OUTCOME',
  }, 'the unresolved open child remains a global fence');

  await journal.markResolved(`${first.operationId}:open`, 'abandoned');
  failOpen = false;
  const next = await lifecycle.ensureProject(PROJECT_A);
  assert.equal(next.operationId, 'editor-use-fence-2');
  await waitForState(lifecycle, next.operationId, EDITOR_HANDOFF_STATES.COMPLETED);
});

test('recovered RUNNING operation is observe-only and never resends close or open', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'editor-lifecycle-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalPath = path.join(root, 'operations.jsonl');
  const first = await OperationJournal.open(journalPath);
  await first.recordReceived({
    operationId: 'editor-use-recovered',
    project: PROJECT_B.name,
    projectKey: PROJECT_B.key,
    method: 'unity_router_editor_use',
    payload: { projectKey: PROJECT_B.key },
  });
  await first.markQueued('editor-use-recovered');
  await first.markDispatching('editor-use-recovered');
  await first.markRunning('editor-use-recovered', 'unity_router_editor_use_status', {
    targetProjectKey: PROJECT_B.key,
    oldPid: String(OLD_EDITOR.pid),
    transitionId: 'transition-recovered',
    phase: 'close-dispatched',
  });
  await first.close();

  const journal = await OperationJournal.open(journalPath);
  let closeCount = 0;
  let openCount = 0;
  const lifecycle = new EditorLifecycle({
    config: {
      projects: [PROJECT_A, PROJECT_B],
      editorHandoff: { mode: 'typed-auto-close', pollIntervalMs: 1, editorExitTimeoutSec: 0.1, startupTimeoutSec: 0.1 },
    },
    journal,
    processAudit: async () => ({ ok: true, editors: [TARGET_EDITOR] }),
    projectAccess: async () => ({ ok: true }),
    callTool: async (project, name) => {
      if (name === 'zamgune_editor_close') closeCount += 1;
      return { ready: true, projectPath: PROJECT_B.path, playMode: 'stopped' };
    },
    openProject: async () => { openCount += 1; },
    delay: async () => {},
    logger: { error() {}, warn() {} },
  });
  t.after(async () => {
    await lifecycle.close();
    await journal.close();
  });

  await lifecycle.ready();
  const completed = await waitForState(lifecycle, 'editor-use-recovered', EDITOR_HANDOFF_STATES.COMPLETED);
  assert.equal(completed.recovered, true);
  assert.equal(completed.observeOnly, true);
  assert.equal(closeCount, 0);
  assert.equal(openCount, 0);
});

test('an existing lifecycle UNKNOWN_OUTCOME prevents queued recovery from dispatching open', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'editor-lifecycle-unknown-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalPath = path.join(root, 'operations.jsonl');
  const first = await OperationJournal.open(journalPath);
  await first.recordReceived({
    operationId: 'orphan-open',
    project: PROJECT_A.name,
    projectKey: PROJECT_A.key,
    method: 'unity_router_editor_open',
    payload: {},
  });
  await first.markQueued('orphan-open');
  await first.markDispatching('orphan-open');
  await first.markUnknownOutcome('orphan-open');
  await first.recordReceived({
    operationId: 'queued-parent',
    project: PROJECT_B.name,
    projectKey: PROJECT_B.key,
    method: 'unity_router_editor_use',
    payload: { projectKey: PROJECT_B.key },
  });
  await first.markQueued('queued-parent');
  await first.close();

  const journal = await OperationJournal.open(journalPath);
  let openCount = 0;
  const lifecycle = new EditorLifecycle({
    config: {
      projects: [PROJECT_A, PROJECT_B],
      editorHandoff: { mode: 'manual-close', pollIntervalMs: 1, editorExitTimeoutSec: 0.1, startupTimeoutSec: 0.1 },
    },
    journal,
    processAudit: async () => ({ ok: true, editors: [] }),
    projectAccess: async () => ({ ok: true }),
    callTool: async () => ({ status: 'ready', projectPath: PROJECT_B.path, playMode: 'stopped' }),
    openProject: async () => { openCount += 1; },
    delay: async () => {},
    logger: { error() {}, warn() {} },
  });
  t.after(async () => {
    await lifecycle.close();
    await journal.close();
  });

  await lifecycle.ready();
  assert.equal(openCount, 0);
  assert.equal(lifecycle.status('queued-parent').state, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME);
  assert.deepEqual(lifecycle.status('queued-parent').blockers, ['RECOVERY_BLOCKED_BY_UNKNOWN_OUTCOME']);
  assert.equal(journal.get('queued-parent').state, 'UNKNOWN_OUTCOME');
});

test('same-target request joins active operation while another target is rejected', async (t) => {
  const { lifecycle } = await fixture(t, {
    processAudit: async () => ({ ok: true, editors: [OLD_EDITOR] }),
    delay: (ms, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const first = await lifecycle.ensureProject(PROJECT_B);
  await waitForState(lifecycle, first.operationId, EDITOR_HANDOFF_STATES.WAITING_MANUAL_CLOSE);

  const joined = await lifecycle.ensureProject(PROJECT_B);
  assert.equal(joined.operationId, first.operationId);
  assert.equal(lifecycle.activeStatus().operationId, first.operationId);
  await assert.rejects(() => lifecycle.ensureProject(PROJECT_A), { code: 'EDITOR_HANDOFF_BUSY' });
});
