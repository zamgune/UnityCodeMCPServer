import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { OPERATION_STATES } from './operation-journal.mjs';

export const EDITOR_HANDOFF_STATES = Object.freeze({
  QUEUED: 'QUEUED',
  PRECHECK: 'PRECHECK',
  WAITING_MANUAL_CLOSE: 'WAITING_MANUAL_CLOSE',
  QUIT_DISPATCHED: 'QUIT_DISPATCHED',
  WAITING_OLD_EDITOR_EXIT: 'WAITING_OLD_EDITOR_EXIT',
  OPEN_DISPATCHED: 'OPEN_DISPATCHED',
  WAITING_TARGET_PROCESS: 'WAITING_TARGET_PROCESS',
  WAITING_PIPELINE: 'WAITING_PIPELINE',
  WAITING_IMPORT: 'WAITING_IMPORT',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
});

const TERMINAL_STATES = new Set([
  EDITOR_HANDOFF_STATES.COMPLETED,
  EDITOR_HANDOFF_STATES.BLOCKED,
  EDITOR_HANDOFF_STATES.CANCELLED,
  EDITOR_HANDOFF_STATES.FAILED,
  EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME,
]);

const PARENT_METHOD = 'unity_router_editor_use';
const OPEN_METHOD = 'unity_router_editor_open';
const STATUS_TOOL = 'unity_router_editor_use_status';

export class EditorLifecycleError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'EditorLifecycleError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function asPositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function msFrom(config, millisecondName, secondName, fallback) {
  if (Number.isFinite(config?.[millisecondName]) && config[millisecondName] > 0) {
    return Math.floor(config[millisecondName]);
  }
  if (Number.isFinite(config?.[secondName]) && config[secondName] > 0) {
    return Math.floor(config[secondName] * 1_000);
  }
  return fallback;
}

function normalizeOptions(config) {
  const raw = config?.editorHandoff ?? {};
  const editorExitTimeoutMs = msFrom(raw, 'oldEditorExitTimeoutMs', 'oldEditorExitTimeoutSec',
    msFrom(raw, 'editorExitTimeoutMs', 'editorExitTimeoutSec', 180_000));
  const startupTimeoutMs = msFrom(raw, 'targetProcessTimeoutMs', 'targetProcessTimeoutSec',
    msFrom(raw, 'startupTimeoutMs', 'startupTimeoutSec', 900_000));
  return Object.freeze({
    mode: raw.mode ?? 'disabled',
    pollIntervalMs: asPositiveInteger(raw.pollIntervalMs, 500),
    statusTimeoutMs: msFrom(raw, 'statusTimeoutMs', 'statusTimeoutSec',
      Number.isFinite(config?.toolTimeoutSec) ? config.toolTimeoutSec * 1_000 : 10_000),
    oldEditorExitTimeoutMs: editorExitTimeoutMs,
    targetProcessTimeoutMs: startupTimeoutMs,
    pipelineTimeoutMs: msFrom(raw, 'pipelineTimeoutMs', 'pipelineTimeoutSec', startupTimeoutMs),
  });
}

function canonicalPath(value) {
  return typeof value === 'string' && value.length > 0 ? path.resolve(value) : null;
}

function dateFromClock(clock) {
  const value = clock();
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return new Date(value);
}

function iso(clock) {
  return dateFromClock(clock).toISOString();
}

function nowMs(clock) {
  return dateFromClock(clock).getTime();
}

function cloneEditor(editor) {
  if (!editor) return null;
  return { pid: editor.pid, projectPath: editor.projectPath };
}

function cloneSnapshot(job) {
  return Object.freeze({
    operationId: job.operationId,
    target: Object.freeze({
      project: job.project.name,
      projectKey: job.project.key,
      projectPath: job.project.path,
    }),
    state: job.state,
    oldEditor: cloneEditor(job.oldEditor),
    blockers: Object.freeze([...(job.blockers ?? [])]),
    timestamps: Object.freeze({ ...job.timestamps }),
    mode: job.mode,
    recovered: Boolean(job.recovered),
    observeOnly: Boolean(job.observeOnly),
  });
}

function blockerCode(blocker) {
  if (typeof blocker === 'string') return blocker;
  if (blocker && typeof blocker === 'object') {
    return String(blocker.code ?? blocker.kind ?? blocker.message ?? 'EDITOR_NOT_READY');
  }
  return 'EDITOR_NOT_READY';
}

function parseTextContent(result) {
  const content = result?.content ?? result?.result?.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    try {
      return JSON.parse(item.text);
    } catch {
      // A human-readable text response is not a machine-readable lifecycle status.
    }
  }
  return null;
}

function toolPayload(result) {
  if (result?.isError || result?.result?.isError) {
    throw new EditorLifecycleError('EDITOR_TOOL_ERROR', 'Unity lifecycle tool returned an error result');
  }
  return result?.structuredContent ?? result?.result?.structuredContent ?? parseTextContent(result) ?? result;
}

function isStopped(payload) {
  if (payload?.isPlaying === true || payload?.isPlayingOrWillChangePlaymode === true) return false;
  const rawPlayMode = payload?.playMode ?? payload?.play_mode;
  if (rawPlayMode != null) {
    const playMode = String(rawPlayMode).toLowerCase();
    return playMode === 'stopped' || playMode === 'editmode' ||
      playMode === 'edit_mode' || playMode === 'false';
  }
  return payload?.isPlaying === false;
}

function readiness(payload, expectedPath) {
  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase();
  const readyFlag = payload?.ready ?? payload?.isReady;
  const compiling = Boolean(payload?.compiling ?? payload?.isCompiling);
  const updating = Boolean(
    payload?.updating ?? payload?.isUpdating ?? payload?.importing ?? payload?.isImporting ??
    payload?.domainReloadInProgress,
  );
  const returnedPath = canonicalPath(payload?.projectPath ?? payload?.project_path);
  const pathMatches = returnedPath !== null && returnedPath === expectedPath;
  const typedHandoffStatus = typeof payload?.canClose === 'boolean' &&
    typeof payload?.compiling === 'boolean' && typeof payload?.updating === 'boolean';
  const ready = readyFlag === true || status === 'ready' || typedHandoffStatus;
  const blockers = [];
  if (returnedPath === null) blockers.push('PIPELINE_PROJECT_IDENTITY_MISSING');
  else if (!pathMatches) blockers.push('PIPELINE_PROJECT_MISMATCH');
  if (!ready) blockers.push('PIPELINE_NOT_READY');
  if (compiling) blockers.push('EDITOR_COMPILING');
  if (updating) blockers.push('EDITOR_IMPORTING_OR_RELOADING');
  if (!isStopped(payload)) blockers.push('PLAY_MODE_ACTIVE');
  return { ready: ready && pathMatches && !compiling && !updating && isStopped(payload), blockers, compiling, updating };
}

function gateResult(value, defaultBlocker) {
  if (Array.isArray(value)) return value.map(blockerCode);
  if (value === undefined || value === true || value?.ok === true || value?.allowed === true) return [];
  if (value === false || value === null) return [defaultBlocker];
  const blockers = value?.blockers ?? value?.reasons;
  if (Array.isArray(blockers) && blockers.length > 0) return blockers.map(blockerCode);
  return [blockerCode(value?.code ?? value?.message ?? defaultBlocker)];
}

function defaultDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function projectByKey(config, key) {
  return config.projects?.find((project) => project.key === key) ?? null;
}

function projectByPath(config, projectPath) {
  const expected = canonicalPath(projectPath);
  return config.projects?.find((project) => canonicalPath(project.path) === expected) ?? null;
}

function isUnavailableTool(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '').toLowerCase();
  return code === '-32601' || code === 'METHOD_NOT_FOUND' || code === 'TOOL_NOT_FOUND' ||
    message.includes('not found') || message.includes('unknown tool');
}

/**
 * Fail-closed lifecycle coordinator for a single licensed Unity Editor seat.
 *
 * `ensureProject()` durably queues a tracked operation and returns before the
 * handoff finishes. The caller polls `status(operationId)`. This class never
 * saves/discards scenes, exits play mode, sends OS signals, or retries either
 * Editor close or Editor open after dispatch uncertainty.
 */
export class EditorLifecycle {
  constructor({
    config,
    journal,
    processAudit,
    projectAccess,
    callTool,
    stopChild = async () => {},
    openProject,
    brokerIdle = async () => true,
    switchAllowed = async () => true,
    onStateChange = () => {},
    logger = console,
    clock = () => new Date(),
    delay = defaultDelay,
    operationId = () => randomUUID(),
  }) {
    if (!config || !journal || typeof processAudit !== 'function' || typeof projectAccess !== 'function' ||
      typeof callTool !== 'function' || typeof openProject !== 'function' || typeof onStateChange !== 'function') {
      throw new TypeError('EditorLifecycle requires config, journal, processAudit, projectAccess, callTool, and openProject');
    }
    this.config = config;
    this.options = normalizeOptions(config);
    if (!new Set(['disabled', 'manual-close', 'typed-auto-close']).has(this.options.mode)) {
      throw new TypeError(`Unsupported editor handoff mode: ${this.options.mode}`);
    }
    this.journal = journal;
    this.processAudit = processAudit;
    this.projectAccess = projectAccess;
    this.callTool = callTool;
    this.stopChild = stopChild;
    this.openProject = openProject;
    this.brokerIdle = brokerIdle;
    this.switchAllowed = switchAllowed;
    this.onStateChange = onStateChange;
    this.logger = logger;
    this.clock = clock;
    this.delay = delay;
    this.operationId = operationId;
    this.jobs = new Map();
    this.active = null;
    this.closed = false;
    this.abortController = new AbortController();
    this.ensureTail = Promise.resolve();
    this.inFlightEnsures = new Set();
    this.recoveryPromise = Promise.resolve().then(() => this.#recover());
  }

  async ensureProject(project) {
    this.#assertOpen();
    let settleEnsure;
    const ensureSettled = new Promise((resolve) => { settleEnsure = resolve; });
    this.inFlightEnsures.add(ensureSettled);
    try {
      await this.recoveryPromise;
      let unlock;
      const previous = this.ensureTail;
      this.ensureTail = new Promise((resolve) => { unlock = resolve; });
      await previous;
      try {
        this.#assertOpen();
        this.#assertConfiguredProject(project);
        if (this.options.mode === 'disabled') {
          throw new EditorLifecycleError('EDITOR_HANDOFF_DISABLED', 'Editor handoff is disabled');
        }
        const unknown = this.#unknownOperations();
        if (unknown.length > 0) {
          throw new EditorLifecycleError(
            'EDITOR_HANDOFF_UNKNOWN_OUTCOME',
            'An unresolved Editor lifecycle side effect blocks every new handoff',
            { operationIds: unknown.map((operation) => operation.operationId) },
          );
        }
        if (this.active && !TERMINAL_STATES.has(this.active.state)) {
          if (this.active.project.key === project.key) return cloneSnapshot(this.active);
          throw new EditorLifecycleError('EDITOR_HANDOFF_BUSY', 'Another Editor handoff is already active', {
            operationId: this.active.operationId,
            targetProjectKey: this.active.project.key,
          });
        }

        const operationId = this.operationId(project);
        await this.journal.recordReceived({
          operationId,
          project: project.name,
          projectKey: project.key,
          method: PARENT_METHOD,
          payload: { projectKey: project.key, projectPath: project.path, mode: this.options.mode },
        });
        await this.journal.markQueued(operationId);
        const job = this.#newJob({ operationId, project, state: EDITOR_HANDOFF_STATES.QUEUED });
        this.jobs.set(operationId, job);
        this.active = job;
        this.#launch(job);
        return cloneSnapshot(job);
      } finally {
        unlock();
      }
    } finally {
      this.inFlightEnsures.delete(ensureSettled);
      settleEnsure();
    }
  }

  async ready() {
    await this.recoveryPromise;
  }

  status(operationId) {
    const job = this.jobs.get(operationId);
    if (job) {
      if (job.state === EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME &&
        this.journal.get(operationId)?.state === OPERATION_STATES.RESOLVED) {
        this.#setState(job, EDITOR_HANDOFF_STATES.CANCELLED, ['ADMIN_RESOLVED']);
      }
      return cloneSnapshot(job);
    }
    const operation = this.journal.get(operationId);
    if (!operation || operation.method !== PARENT_METHOD) return null;
    const project = projectByKey(this.config, operation.projectKey);
    if (!project) return null;
    return Object.freeze({
      operationId,
      target: Object.freeze({ project: project.name, projectKey: project.key, projectPath: project.path }),
      state: operation.state,
      oldEditor: null,
      blockers: Object.freeze([]),
      timestamps: Object.freeze({ createdAt: operation.receivedAt, updatedAt: operation.updatedAt }),
      mode: this.options.mode,
      recovered: true,
      observeOnly: operation.state === OPERATION_STATES.RUNNING,
    });
  }

  activeStatus() {
    if (!this.active || TERMINAL_STATES.has(this.active.state)) return null;
    return cloneSnapshot(this.active);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.abortController.abort(new EditorLifecycleError(
        'EDITOR_LIFECYCLE_CLOSED',
        'Editor lifecycle coordinator closed',
      ));
    }
    await Promise.allSettled([this.recoveryPromise]);
    await Promise.allSettled([...this.inFlightEnsures]);
    await Promise.allSettled(
      [...this.jobs.values()].map((job) => job.promise).filter(Boolean),
    );
  }

  #assertOpen() {
    if (this.closed) throw new EditorLifecycleError('EDITOR_LIFECYCLE_CLOSED', 'Editor lifecycle coordinator closed');
  }

  #unknownOperations() {
    return this.journal.list({ state: OPERATION_STATES.UNKNOWN_OUTCOME })
      .filter((operation) => operation.method === PARENT_METHOD || operation.method === OPEN_METHOD);
  }

  #assertConfiguredProject(project) {
    const configured = projectByKey(this.config, project?.key);
    if (!configured || canonicalPath(configured.path) !== canonicalPath(project.path)) {
      throw new EditorLifecycleError('EDITOR_PROJECT_NOT_CONFIGURED', 'Target project is not an exact configured project');
    }
  }

  #newJob({ operationId, project, state, recovered = false, observeOnly = false, oldEditor = null, transitionId }) {
    const createdAt = iso(this.clock);
    return {
      operationId,
      project,
      state,
      oldEditor,
      blockers: [],
      mode: this.options.mode,
      recovered,
      observeOnly,
      transitionId: transitionId ?? randomUUID(),
      openOperationId: `${operationId}:open`,
      closeDispatched: false,
      openDispatched: false,
      timestamps: { createdAt, updatedAt: createdAt, [state]: createdAt },
    };
  }

  #setState(job, state, blockers = undefined) {
    const at = iso(this.clock);
    job.state = state;
    if (blockers !== undefined) job.blockers = [...new Set(blockers.map(blockerCode))];
    job.timestamps.updatedAt = at;
    job.timestamps[state] = at;
    if (TERMINAL_STATES.has(state) && this.active === job) this.active = null;
    try {
      Promise.resolve(this.onStateChange(cloneSnapshot(job))).catch((error) => {
        this.logger?.warn?.('Editor lifecycle state callback rejected', { operationId: job.operationId, error });
      });
    } catch (error) {
      this.logger?.warn?.('Editor lifecycle state callback failed', { operationId: job.operationId, error });
    }
  }

  #launch(job) {
    job.promise = Promise.resolve()
      .then(() => job.observeOnly ? this.#observeRecovered(job) : this.#run(job))
      .catch(async (error) => {
        if (this.closed && error?.code === 'EDITOR_LIFECYCLE_CLOSED') return;
        this.logger?.error?.('Editor handoff failed', { operationId: job.operationId, error });
        await this.#finish(job, EDITOR_HANDOFF_STATES.FAILED, [error?.code ?? error?.message ?? 'EDITOR_HANDOFF_FAILED']);
      });
  }

  async #recover() {
    const candidates = this.journal.list()
      .filter((operation) => operation.method === PARENT_METHOD)
      .filter((operation) => operation.state === OPERATION_STATES.QUEUED ||
        operation.state === OPERATION_STATES.RUNNING || operation.state === OPERATION_STATES.UNKNOWN_OUTCOME)
      .sort((left, right) => String(left.receivedAt).localeCompare(String(right.receivedAt)));
    const lifecycleUnknownAlreadyExists = this.#unknownOperations().length > 0;

    for (const operation of candidates) {
      const key = operation.projectKey ?? operation.correlation?.targetProjectKey;
      const project = projectByKey(this.config, key);
      if (!project) continue;
      if (operation.state === OPERATION_STATES.UNKNOWN_OUTCOME) {
        const job = this.#newJob({ operationId: operation.operationId, project, state: EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, recovered: true });
        job.blockers = ['JOURNAL_UNKNOWN_OUTCOME'];
        this.jobs.set(job.operationId, job);
        continue;
      }
      if (lifecycleUnknownAlreadyExists || this.active) {
        await this.#markUnknownById(operation.operationId);
        const job = this.#newJob({ operationId: operation.operationId, project, state: EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, recovered: true });
        job.blockers = [lifecycleUnknownAlreadyExists
          ? 'RECOVERY_BLOCKED_BY_UNKNOWN_OUTCOME'
          : 'MULTIPLE_ACTIVE_EDITOR_HANDOFFS'];
        this.jobs.set(job.operationId, job);
        continue;
      }
      const oldPid = Number(operation.correlation?.oldPid);
      const job = this.#newJob({
        operationId: operation.operationId,
        project,
        state: operation.state === OPERATION_STATES.QUEUED
          ? EDITOR_HANDOFF_STATES.QUEUED
          : EDITOR_HANDOFF_STATES.WAITING_TARGET_PROCESS,
        recovered: true,
        observeOnly: operation.state === OPERATION_STATES.RUNNING,
        oldEditor: Number.isSafeInteger(oldPid) ? { pid: oldPid, projectPath: null } : null,
        transitionId: operation.correlation?.transitionId,
      });
      const child = this.journal.get(job.openOperationId);
      job.openDispatched = child?.state === OPERATION_STATES.RUNNING || child?.state === OPERATION_STATES.UNKNOWN_OUTCOME;
      this.jobs.set(job.operationId, job);
      this.active = job;
      this.#launch(job);
    }
  }

  async #run(job) {
    this.#assertOpen();
    this.#setState(job, EDITOR_HANDOFF_STATES.PRECHECK, []);
    const gateBlockers = [
      ...gateResult(await this.brokerIdle(job.project), 'BROKER_NOT_IDLE'),
      ...gateResult(await this.switchAllowed(job.project), 'EDITOR_SWITCH_NOT_ALLOWED'),
    ];
    this.#assertOpen();
    if (gateBlockers.length > 0) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, gateBlockers);
      return;
    }
    if (!(await this.#checkAccess(job))) return;

    const audit = await this.#audit(job);
    if (!audit) return;
    const targetPath = canonicalPath(job.project.path);
    const current = audit.editors[0] ?? null;
    if (current && canonicalPath(current.projectPath) === targetPath) {
      await this.#waitUntilReady(job, current, this.options.pipelineTimeoutMs);
      return;
    }
    if (!current) {
      await this.#dispatchOpen(job);
      return;
    }

    job.oldEditor = cloneEditor(current);
    if (job.mode === 'manual-close') {
      this.#setState(job, EDITOR_HANDOFF_STATES.WAITING_MANUAL_CLOSE, []);
      if (!(await this.#waitForOldEditorExit(job, current))) return;
      await this.#dispatchOpen(job);
      return;
    }

    await this.#dispatchTypedClose(job, current);
  }

  async #dispatchTypedClose(job, oldEditor) {
    this.#assertOpen();
    const oldProject = projectByPath(this.config, oldEditor.projectPath);
    if (!oldProject) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, ['OLD_EDITOR_PROJECT_NOT_CONFIGURED']);
      return;
    }
    let payload;
    try {
      payload = toolPayload(await this.callTool(
        oldProject,
        'zamgune_handoff_status',
        {},
        this.options.statusTimeoutMs,
      ));
      this.#assertOpen();
    } catch (error) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, [
        isUnavailableTool(error) ? 'TYPED_HANDOFF_TOOL_UNAVAILABLE' : (error?.code ?? 'HANDOFF_STATUS_FAILED'),
      ]);
      return;
    }
    const blockers = Array.isArray(payload?.blockers) ? payload.blockers.map(blockerCode) : [];
    const returnedPath = canonicalPath(payload?.projectPath ?? payload?.project_path);
    const returnedPid = payload?.pid ?? payload?.editorPid ?? payload?.currentPid;
    if (returnedPath !== canonicalPath(oldEditor.projectPath) ||
      Number(returnedPid) !== oldEditor.pid) {
      blockers.push('HANDOFF_STATUS_IDENTITY_MISMATCH');
    }
    if (payload?.canClose !== true || blockers.length > 0) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, blockers.length > 0 ? blockers : ['EDITOR_CANNOT_CLOSE']);
      return;
    }

    await this.journal.markDispatching(job.operationId);
    this.#assertOpen();
    job.closeDispatched = true;
    this.#setState(job, EDITOR_HANDOFF_STATES.QUIT_DISPATCHED, []);
    try {
      const closePayload = toolPayload(await this.callTool(oldProject, 'zamgune_editor_close', {
        expectedProjectPath: oldEditor.projectPath,
        expectedPid: oldEditor.pid,
        transitionId: job.transitionId,
      }, this.options.statusTimeoutMs));
      this.#assertOpen();
      if (closePayload?.scheduled !== true) {
        const closeBlockers = Array.isArray(closePayload?.blockers)
          ? closePayload.blockers.map(blockerCode)
          : [];
        await this.journal.markCancelled(job.operationId);
        this.#setState(job, EDITOR_HANDOFF_STATES.BLOCKED,
          closeBlockers.length > 0 ? closeBlockers : ['EDITOR_CLOSE_NOT_SCHEDULED']);
        return;
      }
      await this.journal.markRunning(job.operationId, STATUS_TOOL, {
        targetProjectKey: job.project.key,
        oldPid: String(oldEditor.pid),
        transitionId: job.transitionId,
        phase: 'close-dispatched',
      });
    } catch (error) {
      await this.#markUnknown(job);
      this.#setState(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, [error?.code ?? 'EDITOR_CLOSE_DELIVERY_UNCERTAIN']);
      return;
    }
    this.#setState(job, EDITOR_HANDOFF_STATES.WAITING_OLD_EDITOR_EXIT, []);
    if (!(await this.#waitForOldEditorExit(job, oldEditor))) return;
    await this.#dispatchOpen(job);
  }

  async #waitForOldEditorExit(job, oldEditor) {
    const deadline = nowMs(this.clock) + this.options.oldEditorExitTimeoutMs;
    while (nowMs(this.clock) <= deadline) {
      this.#assertOpen();
      const audit = await this.#audit(job);
      if (!audit) return false;
      const samePid = audit.editors.find((editor) => editor.pid === oldEditor.pid);
      if (!samePid) {
        const target = audit.editors.find((editor) => canonicalPath(editor.projectPath) === canonicalPath(job.project.path));
        if (target) {
          await this.#waitUntilReady(job, target, this.options.pipelineTimeoutMs);
          return false;
        }
        if (audit.editors.length > 0) {
          await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, ['UNEXPECTED_EDITOR_APPEARED']);
          return false;
        }
        const oldProject = projectByPath(this.config, oldEditor.projectPath);
        if (oldProject) {
          try { await this.stopChild(oldProject); } catch (error) {
            this.logger?.warn?.('Failed to stop old Unity MCP child after Editor exit', { error });
          }
        }
        if (!(await this.#checkAccess(job))) return false;
        return true;
      }
      if (canonicalPath(samePid.projectPath) !== canonicalPath(oldEditor.projectPath)) {
        await this.#finish(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, ['OLD_EDITOR_PID_REUSED']);
        return false;
      }
      await this.delay(this.options.pollIntervalMs, this.abortController.signal);
    }
    await this.#finish(job, EDITOR_HANDOFF_STATES.FAILED, ['OLD_EDITOR_EXIT_TIMEOUT']);
    return false;
  }

  async #dispatchOpen(job) {
    this.#assertOpen();
    if (job.observeOnly || job.openDispatched) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, ['OPEN_REDISPATCH_FORBIDDEN']);
      return;
    }
    if (!(await this.#checkAccess(job))) return;
    this.#assertOpen();

    const parentState = this.journal.get(job.operationId)?.state;
    if (parentState === OPERATION_STATES.QUEUED) await this.journal.markDispatching(job.operationId);
    await this.journal.recordReceived({
      operationId: job.openOperationId,
      project: job.project.name,
      projectKey: job.project.key,
      method: OPEN_METHOD,
      payload: { parentOperationId: job.operationId, projectKey: job.project.key, transitionId: job.transitionId },
    });
    await this.journal.markQueued(job.openOperationId);
    await this.journal.markDispatching(job.openOperationId);
    this.#assertOpen();
    job.openDispatched = true;
    this.#setState(job, EDITOR_HANDOFF_STATES.OPEN_DISPATCHED, []);
    try {
      await this.openProject(job.project);
      this.#assertOpen();
      await this.journal.markRunning(job.openOperationId, STATUS_TOOL, {
        parentOperationId: job.operationId,
        targetProjectKey: job.project.key,
        transitionId: job.transitionId,
      });
      if (this.journal.get(job.operationId)?.state === OPERATION_STATES.DISPATCHING) {
        await this.journal.markRunning(job.operationId, STATUS_TOOL, {
          targetProjectKey: job.project.key,
          oldPid: String(job.oldEditor?.pid ?? 0),
          transitionId: job.transitionId,
          phase: 'open-dispatched',
        });
      }
    } catch (error) {
      await this.#markUnknownById(job.openOperationId);
      await this.#markUnknown(job);
      this.#setState(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, [error?.code ?? 'EDITOR_OPEN_DELIVERY_UNCERTAIN']);
      return;
    }
    await this.#waitForTargetProcess(job);
  }

  async #waitForTargetProcess(job) {
    this.#setState(job, EDITOR_HANDOFF_STATES.WAITING_TARGET_PROCESS, []);
    const deadline = nowMs(this.clock) + this.options.targetProcessTimeoutMs;
    while (nowMs(this.clock) <= deadline) {
      this.#assertOpen();
      const audit = await this.#audit(job);
      if (!audit) return;
      const target = audit.editors.find((editor) => canonicalPath(editor.projectPath) === canonicalPath(job.project.path));
      if (target) {
        await this.#waitUntilReady(job, target, this.options.pipelineTimeoutMs);
        return;
      }
      if (audit.editors.length > 0) {
        await this.#finish(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, ['OPENED_EDITOR_PROJECT_MISMATCH']);
        return;
      }
      await this.delay(this.options.pollIntervalMs, this.abortController.signal);
    }
    await this.#finish(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, ['TARGET_EDITOR_PROCESS_TIMEOUT']);
  }

  async #waitUntilReady(job, editor, timeoutMs) {
    const deadline = nowMs(this.clock) + timeoutMs;
    while (nowMs(this.clock) <= deadline) {
      this.#assertOpen();
      const audit = await this.#audit(job);
      if (!audit) return;
      const exact = audit.editors.find((candidate) => candidate.pid === editor.pid &&
        canonicalPath(candidate.projectPath) === canonicalPath(job.project.path));
      if (!exact) {
        this.#setState(job, EDITOR_HANDOFF_STATES.WAITING_TARGET_PROCESS, ['TARGET_EDITOR_NOT_OBSERVED']);
        await this.delay(this.options.pollIntervalMs, this.abortController.signal);
        continue;
      }
      let payload;
      try {
        payload = await this.#readTargetStatus(job.project);
        this.#assertOpen();
      } catch (error) {
        this.#setState(job, EDITOR_HANDOFF_STATES.WAITING_PIPELINE, [error?.code ?? 'PIPELINE_NOT_READY']);
        await this.delay(this.options.pollIntervalMs, this.abortController.signal);
        continue;
      }
      const value = readiness(payload, canonicalPath(job.project.path));
      if (value.ready) {
        await this.#finish(job, EDITOR_HANDOFF_STATES.COMPLETED, []);
        return;
      }
      this.#setState(job, value.compiling || value.updating
        ? EDITOR_HANDOFF_STATES.WAITING_IMPORT
        : EDITOR_HANDOFF_STATES.WAITING_PIPELINE, value.blockers);
      await this.delay(this.options.pollIntervalMs, this.abortController.signal);
    }
    await this.#finish(job, EDITOR_HANDOFF_STATES.FAILED, ['PIPELINE_READY_TIMEOUT']);
  }

  async #readTargetStatus(project) {
    try {
      return toolPayload(await this.callTool(project, 'zamgune_handoff_status', {}, this.options.statusTimeoutMs));
    } catch (error) {
      if (!isUnavailableTool(error)) throw error;
      return toolPayload(await this.callTool(project, 'editor_status', {}, this.options.statusTimeoutMs));
    }
  }

  async #observeRecovered(job) {
    // A recovered RUNNING operation is observation-only. Journal persistence
    // proves that a side effect may already have happened, but not which UI
    // transition the user saw. Never resend close or open from here.
    const audit = await this.#audit(job);
    if (!audit) return;
    const target = audit.editors.find((editor) => canonicalPath(editor.projectPath) === canonicalPath(job.project.path));
    if (target) {
      await this.#waitUntilReady(job, target, this.options.pipelineTimeoutMs);
      return;
    }
    const oldPid = job.oldEditor?.pid;
    if (Number.isSafeInteger(oldPid) && audit.editors.some((editor) => editor.pid === oldPid)) {
      this.#setState(job, EDITOR_HANDOFF_STATES.WAITING_OLD_EDITOR_EXIT, ['RECOVERED_OBSERVE_ONLY']);
      const deadline = nowMs(this.clock) + this.options.oldEditorExitTimeoutMs;
      while (nowMs(this.clock) <= deadline) {
        await this.delay(this.options.pollIntervalMs, this.abortController.signal);
        const next = await this.#audit(job);
        if (!next) return;
        const nextTarget = next.editors.find((editor) => canonicalPath(editor.projectPath) === canonicalPath(job.project.path));
        if (nextTarget) {
          await this.#waitUntilReady(job, nextTarget, this.options.pipelineTimeoutMs);
          return;
        }
        if (!next.editors.some((editor) => editor.pid === oldPid)) break;
      }
    }
    await this.#finish(job, EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME, ['RECOVERY_SIDE_EFFECT_REDISPATCH_FORBIDDEN']);
  }

  async #audit(job) {
    let audit;
    try {
      audit = await this.processAudit({ force: true });
    } catch (error) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, [error?.code ?? 'PROCESS_AUDIT_FAILED']);
      return null;
    }
    this.#assertOpen();
    const findings = Array.isArray(audit?.findings) ? audit.findings : [];
    const errorFindings = findings.filter((finding) => finding?.severity === 'error');
    if (audit?.ok !== true || errorFindings.length > 0 || !Array.isArray(audit?.editors)) {
      const blockers = errorFindings
        .map((finding) => String(finding.kind ?? 'PROCESS_AUDIT_UNSAFE').toUpperCase());
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, [
        'PROCESS_AUDIT_UNSAFE',
        ...blockers,
      ]);
      return null;
    }
    const editors = Array.isArray(audit?.editors) ? audit.editors : [];
    if (editors.length > 1) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, ['EDITOR_SEAT_LIMIT_EXCEEDED']);
      return null;
    }
    for (const editor of editors) {
      if (!Number.isSafeInteger(editor.pid) || !canonicalPath(editor.projectPath) || !projectByPath(this.config, editor.projectPath)) {
        await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, ['EDITOR_IDENTITY_NOT_EXACT']);
        return null;
      }
    }
    return { ...audit, editors };
  }

  async #checkAccess(job) {
    let result;
    try {
      result = await this.projectAccess(job.project, { force: true });
    } catch (error) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, [error?.code ?? 'PROJECT_ACCESS_DENIED']);
      return false;
    }
    this.#assertOpen();
    if (result === false || result?.ok === false) {
      await this.#finish(job, EDITOR_HANDOFF_STATES.BLOCKED, [result?.code ?? 'PROJECT_ACCESS_DENIED']);
      return false;
    }
    return true;
  }

  async #finish(job, state, blockers) {
    if (TERMINAL_STATES.has(job.state)) return;
    if (state === EDITOR_HANDOFF_STATES.COMPLETED) {
      const parent = this.journal.get(job.operationId);
      if (parent?.state === OPERATION_STATES.QUEUED) await this.journal.markDispatching(job.operationId);
      const refreshed = this.journal.get(job.operationId);
      if (refreshed?.state === OPERATION_STATES.DISPATCHING || refreshed?.state === OPERATION_STATES.RUNNING) {
        await this.journal.markCompleted(job.operationId);
      }
      const child = this.journal.get(job.openOperationId);
      if (child?.state === OPERATION_STATES.RUNNING) await this.journal.markCompleted(job.openOperationId);
    } else if (state === EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME) {
      await this.#markUnknownById(job.openOperationId);
      await this.#markUnknown(job);
    } else {
      await this.#markUnknownById(job.openOperationId);
      const operation = this.journal.get(job.operationId);
      if (operation?.state === OPERATION_STATES.QUEUED) await this.journal.markCancelled(job.operationId);
      else if (operation?.state === OPERATION_STATES.DISPATCHING || operation?.state === OPERATION_STATES.RUNNING) {
        await this.journal.markUnknownOutcome(job.operationId);
      }
    }
    this.#setState(job, state, blockers);
  }

  async #markUnknown(job) {
    await this.#markUnknownById(job.operationId);
  }

  async #markUnknownById(operationId) {
    const operation = this.journal.get(operationId);
    if (!operation || operation.state === OPERATION_STATES.UNKNOWN_OUTCOME) return;
    if (operation.state === OPERATION_STATES.QUEUED) await this.journal.markDispatching(operationId);
    const refreshed = this.journal.get(operationId);
    if (refreshed?.state === OPERATION_STATES.DISPATCHING || refreshed?.state === OPERATION_STATES.RUNNING) {
      await this.journal.markUnknownOutcome(operationId);
    }
  }
}
