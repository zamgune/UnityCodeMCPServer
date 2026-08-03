import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { AuthManager } from './auth-manager.mjs';
import {
  asyncCorrelationFor,
  asyncSpecFor,
  isSuccessfulRecompileCompletion,
  responseIsTerminal,
  responseMatchesAsyncCorrelation,
  responseStartsAsync,
} from './async-operation-policy.mjs';
import { BUILD_INFO } from './build-info.mjs';
import { classifyFailure } from './failure-classifier.mjs';
import { EditorLifecycle, EDITOR_HANDOFF_STATES } from './editor-lifecycle.mjs';
import { LeaseManager } from './lease-manager.mjs';
import { NULL_LOGGER } from './logger.mjs';
import { auditSystemProcesses } from './macos-process-audit.mjs';
import { MCP_PROTOCOL_VERSION as PROTOCOL_VERSION, negotiateMcpProtocolVersion } from './mcp-protocol.mjs';
import { OPERATION_STATES } from './operation-journal.mjs';
import { ProjectAccessAuditor } from './project-access-audit.mjs';
import { ProjectScheduler, SchedulerBudget, SchedulerError } from './project-scheduler.mjs';
import { createRecoveryPolicy, TOOL_CLASSES } from './recovery-policy.mjs';
import { decorateTools, ToolRegistry } from './tool-registry.mjs';
import { UnityMcpChild } from './unity-child.mjs';
import { NULL_WORKSPACE_LEASE_STORE } from './workspace-lease-store.mjs';

const SERVER_VERSION = BUILD_INFO.version;
const SAFE_FORWARDED_METHODS = new Set(['resources/read', 'prompts/get', 'completion/complete']);
const DELIVERY_ACK_TIMEOUT_MS = 5_000;
const TOOL_CATALOG_RECOVERY_GRACE_MS = 10_000;
const TOOL_CATALOG_RECOVERY_POLL_MS = 200;

function textResult(text, isError = false, structuredContent = undefined) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(isError ? { isError: true } : {}),
  };
}

function responseError(id, code, message, data = undefined) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function responseResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function lifecycleToolErrorText(result) {
  const parts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  if (typeof result?.structuredContent?.message === 'string') {
    parts.push(result.structuredContent.message);
  }
  return parts.join('\n').trim().slice(0, 512);
}

function withOperationMetadata(result, operationId, state, extra = {}) {
  const base = result && typeof result === 'object' ? result : textResult(String(result ?? ''));
  const structured = base.structuredContent && typeof base.structuredContent === 'object'
    ? base.structuredContent : {};
  return {
    ...base,
    structuredContent: { ...structured, routerOperationId: operationId, routerOperationState: state, ...extra },
  };
}

function requestKey(clientId, requestId) {
  return `${clientId}:${typeof requestId}:${String(requestId)}`;
}

function execFileBounded(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdoutBytes = Buffer.byteLength(String(stdout ?? ''));
        error.stderrBytes = Buffer.byteLength(String(stderr ?? ''));
        reject(error);
      } else resolve({
        stdoutBytes: Buffer.byteLength(String(stdout ?? '')),
        stderrBytes: Buffer.byteLength(String(stderr ?? '')),
      });
    });
  });
}

function validInitializeParams(params) {
  return params != null
    && typeof params === 'object'
    && !Array.isArray(params)
    && typeof params.protocolVersion === 'string'
    && params.protocolVersion.length > 0
    && params.capabilities != null
    && typeof params.capabilities === 'object'
    && !Array.isArray(params.capabilities)
    && params.clientInfo != null
    && typeof params.clientInfo === 'object'
    && !Array.isArray(params.clientInfo)
    && typeof params.clientInfo.name === 'string'
    && params.clientInfo.name.length > 0
    && typeof params.clientInfo.version === 'string'
    && params.clientInfo.version.length > 0;
}

export function isValidToolCatalog(tools) {
  if (!Array.isArray(tools)) return false;
  const names = new Set();
  for (const tool of tools) {
    if (tool == null || typeof tool !== 'object' || Array.isArray(tool)) return false;
    if (typeof tool.name !== 'string' || tool.name.length === 0 || names.has(tool.name)) return false;
    if (tool.inputSchema == null || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      return false;
    }
    if (tool.description !== undefined && typeof tool.description !== 'string') return false;
    if (
      tool.outputSchema !== undefined
      && (tool.outputSchema == null || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema))
    ) return false;
    names.add(tool.name);
  }
  return true;
}

function responseLooksCancelled(response) {
  if (response?.error?.code === -32800) return true;
  const structured = response?.result?.structuredContent;
  const status = structured && typeof structured === 'object'
    ? [structured.status, structured.state, structured.result, structured.code]
      .filter((value) => typeof value === 'string').join(' ')
    : '';
  const content = Array.isArray(response?.result?.content)
    ? response.result.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join(' ')
    : '';
  return /\bcancel(?:led|ed|ation)?\b/i.test(`${status} ${content}`);
}

function isNativeTool(name) {
  return BROKER_TOOLS.some((tool) => tool.name === name);
}

export const BROKER_TOOLS = Object.freeze([
  {
    name: 'unity_router_status',
    description: 'Report the shared broker, client, queue, lease, operation, auth, and project child state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'unity_router_doctor',
    description: 'Audit direct/legacy MCP bypasses, duplicate brokers, Editor project collisions, and seat limits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'unity_router_editor_use',
    description: 'Queue a tracked single-seat Editor handoff to one configured project. This operator convenience does not reserve a validation turn.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_editor_use_status',
    description: 'Inspect one tracked Editor handoff without replaying close or open side effects.',
    inputSchema: {
      type: 'object',
      properties: { operationId: { type: 'string' } },
      required: ['operationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_restart',
    description: 'Restart one project adapter only when its queue has no active operation.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_drain',
    description: 'Stop accepting new Unity work and wait for queues to become idle before upgrade or rollback.',
    inputSchema: {
      type: 'object',
      properties: { timeoutSec: { type: 'number', minimum: 1, maximum: 600 } },
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_resume',
    description: 'Resume accepting Unity work after a cancelled maintenance attempt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'unity_auth_refresh',
    description: 'Run one shared Unity CLI auth status refresh. Interactive login is never started automatically.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'unity_router_workspace_begin',
    description: 'Acquire the machine-wide Unity validation turn and queue the matching single-seat Editor handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        ttlSec: { type: 'number', minimum: 30, maximum: 3600 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_workspace_heartbeat',
    description: 'Extend an existing workspace lease owned by this client session.',
    inputSchema: {
      type: 'object',
      properties: { leaseToken: { type: 'string' }, ttlSec: { type: 'number', minimum: 30, maximum: 3600 } },
      required: ['leaseToken'],
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_workspace_end',
    description: 'Release a Unity validation turn after tracked import, tests, builds, and handoff work are terminal.',
    inputSchema: {
      type: 'object',
      properties: { leaseToken: { type: 'string' } },
      required: ['leaseToken'],
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_workspace_resolve',
    description: 'Administratively release a persisted/orphaned workspace fence after verifying no source import is active.',
    inputSchema: {
      type: 'object',
      properties: { leaseToken: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['leaseToken', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_operation_status',
    description: 'Inspect a mutation operation, including UNKNOWN_OUTCOME after transport or broker failure.',
    inputSchema: {
      type: 'object',
      properties: { operationId: { type: 'string' } },
      required: ['operationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'unity_router_operation_resolve',
    description: 'Explicitly resolve a verified UNKNOWN_OUTCOME and remove its project mutation fence.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string' },
        resolution: {
          type: 'string',
          enum: ['confirmed_completed', 'safe_to_retry', 'abandoned'],
        },
        confirmNoLongerRunning: { type: 'boolean' },
      },
      required: ['operationId', 'resolution'],
      additionalProperties: false,
    },
  },
]);

const ADMIN_TOOL_NAMES = new Set([
  'unity_router_editor_use',
  'unity_router_restart',
  'unity_router_drain',
  'unity_router_resume',
  'unity_router_workspace_resolve',
  'unity_router_operation_resolve',
]);

const EDITOR_HANDOFF_TERMINAL_STATES = new Set([
  EDITOR_HANDOFF_STATES.COMPLETED,
  EDITOR_HANDOFF_STATES.BLOCKED,
  EDITOR_HANDOFF_STATES.CANCELLED,
  EDITOR_HANDOFF_STATES.FAILED,
  EDITOR_HANDOFF_STATES.UNKNOWN_OUTCOME,
]);

export class BrokerCore {
  constructor({
    config,
    journal,
    workspaceStore = NULL_WORKSPACE_LEASE_STORE,
    logger = NULL_LOGGER,
    env = process.env,
    brokerId = randomUUID(),
    configHash = null,
    processAuditor = auditSystemProcesses,
    projectAccessAuditor = null,
    editorLifecycle = null,
    toolRefreshIntervalMs = 5_000,
    toolCatalogRecoveryGraceMs = TOOL_CATALOG_RECOVERY_GRACE_MS,
    toolCatalogRecoveryPollMs = TOOL_CATALOG_RECOVERY_POLL_MS,
  }) {
    this.config = config;
    this.journal = journal;
    this.workspaceStore = workspaceStore;
    this.logger = logger.child({ brokerId, brokerPid: process.pid });
    this.env = env;
    this.brokerId = brokerId;
    this.configHash = configHash;
    this.processAuditor = processAuditor;
    this.auditCache = null;
    this.auditInFlight = null;
    this.auditGeneration = 0;
    this.auditFollowUps = new Map();
    this.projectAccessAuditor = projectAccessAuditor ?? new ProjectAccessAuditor({
      projects: config.projects,
      env,
      logger: this.logger,
    });
    this.connections = new Map();
    this.children = new Map();
    this.schedulers = new Map();
    this.pendingByRequest = new Map();
    this.pendingByOperation = new Map();
    this.unknownByProject = new Map();
    this.recoveryFaults = new Map();
    this.asyncByProject = new Map();
    this.toolRegistry = new ToolRegistry();
    this.childToolListChangedEpochs = new Map();
    this.recompileListChangedGenerations = new Map();
    this.toolInvalidationEpochs = new Map();
    this.toolInvalidationAnnouncements = new Set();
    this.toolReannounceEpochs = new Map();
    this.toolRecoveryAnnounceEpochs = new Map();
    this.toolDiscoveryInFlight = new Map();
    this.editorHandoffAnnouncements = new Set();
    this.toolRefreshTimer = null;
    this.toolCatalogRecoveryGraceMs = Math.max(0, toolCatalogRecoveryGraceMs);
    this.toolCatalogRecoveryPollMs = Math.max(1, toolCatalogRecoveryPollMs);
    this.recovery = createRecoveryPolicy(config.recovery);
    this.budget = new SchedulerBudget({
      maxPendingTotal: config.queue.maxPendingTotal,
      maxHeavyInFlight: config.queue.maxHeavyInFlight,
    });
    this.leases = new LeaseManager({
      capacities: {
        'editor-seat': config.license?.maxConcurrentEditors ?? 1,
        heavy: config.queue.maxHeavyInFlight,
        'source-refresh': 1,
        'player-connection': 1,
        'exclusive-editor': 1,
      },
      defaultTtlMs: 10 * 60_000,
    });
    this.auth = new AuthManager({
      unityBin: config.unityBin,
      unityArgs: config.unityArgs ?? [],
      env,
      logger: this.logger,
    });
    this.editorLifecycle = editorLifecycle ?? new EditorLifecycle({
      config,
      journal,
      processAudit: () => this.#processAudit({ force: true }),
      projectAccess: (project, options = {}) => this.projectAccessAuditor.assertAccessible(project, {
        force: true,
        ...options,
      }),
      callTool: (project, name, args, timeoutMs) =>
        this.#callEditorLifecycleTool(project, name, args, timeoutMs),
      stopChild: (project) => this.children.get(project.key)?.stop('editor-handoff') ?? Promise.resolve(),
      openProject: (project) => this.#openEditorProject(project),
      brokerIdle: (project) => this.#editorSwitchBlockers(project),
      onStateChange: (snapshot) => this.#onEditorLifecycleState(snapshot),
      logger: this.logger,
    });
    this.shuttingDown = false;
    this.draining = false;
    this.idleTimer = null;
    this.workspaceRecords = new Map();
    for (const persisted of this.workspaceStore.list()) this.#restoreWorkspaceRecord(persisted);
    for (const operation of this.journal.list({ state: OPERATION_STATES.UNKNOWN_OUTCOME })) {
      const project = this.#projectForJournalOperation(operation);
      if (project) this.#addUnknownFence(project.key, operation.operationId);
      else this.#addRecoveryFault(operation, 'UNKNOWN_PROJECT_NOT_CONFIGURED');
    }
    for (const operation of this.journal.list({ state: OPERATION_STATES.RUNNING })) {
      if (operation.method === 'unity_router_editor_use' || operation.method === 'unity_router_editor_open') {
        continue;
      }
      this.#restoreAsyncTracker(operation);
    }
    if (this.config.broker.childIdleMin > 0) {
      const intervalMs = Math.max(1_000, Math.min(60_000, this.config.broker.childIdleMin * 30_000));
      this.idleTimer = setInterval(() => this.#sweepIdleChildren().catch((error) => {
        this.logger.warn('idle child sweep failed', { message: error.message });
      }), intervalMs);
      this.idleTimer.unref();
    }
    if (toolRefreshIntervalMs > 0) {
      this.toolRefreshTimer = setInterval(() => {
        void this.#refreshUnavailableTools().catch((error) => {
          this.logger.debug('background tool refresh failed', { message: error.message });
        });
      }, toolRefreshIntervalMs);
      this.toolRefreshTimer.unref();
    }
    this.logger.info('broker core initialized', { projects: config.projects.map((project) => project.path) });
  }

  attach({ clientId = randomUUID(), sessionNonce = randomUUID(), defaultProject, clientKind = 'unknown', adapterVersion, adapterBuildId, adapterPid, isAdmin = false, configHash, send }) {
    if (typeof send !== 'function') throw new TypeError('send must be a function');
    if (this.connections.has(clientId)) throw new Error(`Client already attached: ${clientId}`);
    const project = this.projectByAlias(defaultProject ?? this.config.defaultProject);
    if (!project) throw new Error(`Unknown default project "${defaultProject}"`);
    const connection = {
      id: clientId,
      sessionNonce,
      clientKind,
      adapterVersion,
      adapterBuildId,
      adapterPid: Number.isSafeInteger(adapterPid) ? adapterPid : null,
      isAdmin: isAdmin === true,
      configHash,
      defaultProject: defaultProject ?? this.config.defaultProject,
      defaultProjectKey: project.key,
      send,
      initialized: false,
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: clientKind, version: adapterVersion ?? '0' },
      usedProjectKeys: new Set([project.key]),
      workspaceLeases: new Map(),
      pendingLeaseRequests: new Map(),
      incomingRequests: new Set(),
      earlyCancellations: new Map(),
      closed: false,
      ready: false,
    };
    for (const record of this.workspaceRecords.values()) {
      if (record.ownerId !== clientId || record.sessionNonce !== sessionNonce) continue;
      connection.workspaceLeases.set(record.projectKey, this.#workspaceSnapshot(record));
    }
    this.connections.set(connection.id, connection);
    this.logger.info('client attached', { clientId, clientKind, defaultProject: connection.defaultProject });
    return connection;
  }

  detach(clientId) {
    const connection = this.connections.get(clientId);
    if (!connection) return;
    connection.closed = true;
    this.connections.delete(clientId);
    for (const handle of connection.pendingLeaseRequests.values()) {
      try { handle.cancel('client disconnected'); } catch { /* already granted/cancelled */ }
    }
    connection.pendingLeaseRequests.clear();
    for (const operation of this.pendingByOperation.values()) {
      if (operation.clientId !== clientId) continue;
      if (operation.kind === 'tools-list') {
        operation.connectionLost = true;
        this.#cancelToolListOperation(operation, 'client disconnected');
        continue;
      }
      operation.connectionLost = true;
      const tracker = this.asyncByProject.get(operation.projectKey);
      if (operation.state === 'RUNNING') {
        if (!operation.deliveryAcknowledged && tracker?.operationId === operation.operationId) {
          operation.deliveryDecision = 'LOST';
          tracker.deliveryUncertain = true;
          this.#clearDeliveryTimer(operation);
          if (tracker.terminalObserved) {
            void this.#completeAsyncTracker(tracker).catch((error) => {
              this.draining = true;
              this.logger.error('terminal async operation could not be fenced after adapter disconnect', {
                operationId: operation.operationId,
                message: error.message,
              });
            });
          }
        }
        continue;
      }
      if (operation.state === 'DELIVERING') {
        this.#loseSynchronousDelivery(operation, 'adapter disconnected before response acknowledgement');
        continue;
      }
      operation.cancelRequested = true;
      this.#cancelOperationToolDiscoveries(operation, 'client disconnected');
      if (this.#abortStartingChild(operation, 'client disconnected')) continue;
      if (operation.state === 'QUEUED') {
        this.schedulers.get(operation.projectKey)?.cancel(operation.operationId, 'client disconnected');
      } else if (operation.state === 'DISPATCHING' && operation.childRequestId) {
        operation.cancelAfterDispatch = true;
        const child = this.children.get(operation.projectKey);
        child?.cancel(operation.childRequestId, 'client disconnected');
        // Once the adapter is gone there is no safe delivery path. Quarantine
        // the shared CLI child so an ignored cancellation cannot hold this
        // project's scheduler and global mutation leases until toolTimeout.
        // The owning coroutine alone performs the durable journal transition.
        void child?.stop('adapter-disconnect').catch((error) => {
          this.logger.warn('failed to quarantine Unity child after adapter disconnect', {
            operationId: operation.operationId,
            message: error.message,
          });
        });
      }
    }
    // Workspace leases intentionally remain until heartbeat/reconciliation. An
    // adapter disconnect must never silently hand a source-refresh lease to a
    // second writer while the first Editor may still be importing.
    this.logger.info('client detached', { clientId });
  }

  projectByAlias(alias) {
    const key = this.config.aliases?.[alias];
    return key == null ? undefined : this.config.projects.find((project) => project.key === key);
  }

  projectName(project) {
    return project.name ?? project.aliases?.[0] ?? project.path;
  }

  schedulerFor(project) {
    let scheduler = this.schedulers.get(project.key);
    if (!scheduler) {
      scheduler = new ProjectScheduler({
        projectKey: project.key,
        budget: this.budget,
        maxPendingPerClient: this.config.queue.maxPendingPerClient,
        maxPendingPerProject: this.config.queue.maxPendingPerProject,
        deadlineSec: this.config.queue.deadlineSec,
      });
      this.schedulers.set(project.key, scheduler);
    }
    return scheduler;
  }

  childFor(project) {
    let child = this.children.get(project.key);
    if (!child) {
      child = new UnityMcpChild({
        project,
        unityBin: project.unityBin ?? this.config.unityBin,
        unityArgs: this.config.unityArgs ?? [],
        startupTimeoutMs: this.config.startupTimeoutSec * 1000,
        toolTimeoutMs: this.config.toolTimeoutSec * 1000,
        env: this.env,
        logger: this.logger,
        beforeSpawn: async ({ deadlineAt }) => {
          await this.projectAccessAuditor.assertAccessible(project, {
            force: true,
            deadlineAt,
          });
          const inactive = await this.#singleSeatInactiveProject(project, { force: true });
          if (inactive) {
            throw new SchedulerError(
              inactive.content?.[0]?.text ?? 'The exact single-seat Unity Editor is not active.',
              {
                code: inactive.structuredContent?.code ?? 'PROJECT_EDITOR_INACTIVE',
                details: inactive.structuredContent,
              },
            );
          }
        },
        onNotification: (message, context) => this.#onChildNotification(project, message, context),
        onLifecycle: (event) => this.#onChildLifecycle(project, event),
      });
      this.children.set(project.key, child);
    }
    return child;
  }

  #abortStartingChild(operation, reason = 'client cancelled') {
    if (!operation.startingChild) return false;
    const child = this.children.get(operation.projectKey);
    if (child && operation.childRequestId) {
      child.cancel(operation.childRequestId, reason);
      void child.stop('startup-cancel').catch(() => {});
    }
    return true;
  }

  async #startChildForOperation(child, connection, operation, deadlineAt) {
    const remainingMs = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : this.config.startupTimeoutSec * 1000;
    if (remainingMs <= 0) {
      throw new SchedulerError(`Operation ${operation.operationId} deadline expired before startup`, {
        code: 'DEADLINE_EXCEEDED',
      });
    }
    operation.startingChild = true;
    try {
      await child.start(connection.protocolVersion, connection.clientInfo, {
        connectionId: connection.id,
        clientRequestId: operation.clientRequestId,
        operationId: operation.operationId,
        deadlineAt,
        startupTimeoutMs: Math.min(this.config.startupTimeoutSec * 1000, remainingMs),
        onChildRequestId: (childId) => {
          operation.childRequestId = childId;
          if (operation.cancelRequested) this.#abortStartingChild(operation, 'client cancelled');
        },
      });
    } catch (error) {
      if (operation.cancelRequested) {
        throw new SchedulerError(`Operation ${operation.operationId} cancelled during startup`, {
          code: 'CANCELLED',
        });
      }
      if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
        throw new SchedulerError(`Operation ${operation.operationId} deadline expired during startup`, {
          code: 'DEADLINE_EXCEEDED',
        });
      }
      throw error;
    } finally {
      operation.startingChild = false;
      operation.childRequestId = null;
    }
    if (operation.cancelRequested) {
      throw new SchedulerError(`Operation ${operation.operationId} cancelled after startup`, {
        code: 'CANCELLED',
      });
    }
    if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      throw new SchedulerError(`Operation ${operation.operationId} deadline expired during startup`, {
        code: 'DEADLINE_EXCEEDED',
      });
    }
  }

  async handle(clientId, message) {
    const connection = this.connections.get(clientId);
    if (!connection || connection.closed) return;
    const { id, method, params } = message;
    if (id == null) {
      if (method === 'notifications/cancelled') this.#cancelClientRequest(connection, params);
      if (method === 'notifications/initialized' && connection.initialized) connection.ready = true;
      return;
    }

    const incomingRequestKey = requestKey(connection.id, id);
    connection.incomingRequests.add(incomingRequestKey);

    try {
      if (method === 'initialize') {
        if (connection.initialized) {
          connection.send(responseError(id, -32600, 'Connection is already initialized'));
          return;
        }
        if (!validInitializeParams(params)) {
          connection.send(responseError(id, -32602, 'Invalid initialize params'));
          return;
        }
        connection.protocolVersion = negotiateMcpProtocolVersion(params?.protocolVersion);
        connection.clientInfo = params?.clientInfo ?? connection.clientInfo;
        connection.initialized = true;
        connection.send(responseResult(id, {
          protocolVersion: connection.protocolVersion,
          capabilities: {
            completions: {},
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            tools: { listChanged: true },
          },
          serverInfo: { name: 'unity-mcp-broker', version: SERVER_VERSION },
          instructions:
            `Shared broker for Unity's official unity mcp. Default project: ${connection.defaultProject}. ` +
            'Mutations are serialized and are never blindly retried after dispatch.',
        }));
        return;
      }
      if (!connection.ready && method !== 'ping') {
        connection.send(responseError(id, -32002, 'Server is not initialized'));
        return;
      }
      if (method === 'ping') {
        connection.send(responseResult(id, {}));
        return;
      }
      // Recovery is observe-only for any handoff that may already have
      // dispatched close/open. Do not let discovery or tool calls race ahead
      // of the durable journal reconstruction performed by EditorLifecycle.
      await this.editorLifecycle.ready?.();
      if (connection.closed || this.connections.get(connection.id) !== connection) return;
      if (connection.earlyCancellations.has(incomingRequestKey)) {
        throw new SchedulerError(`Request ${String(id)} cancelled before broker dispatch`, {
          code: 'CANCELLED',
        });
      }
      if (method === 'tools/list') {
        const project = this.projectByAlias(connection.defaultProject);
        const tools = await this.#getTools(connection, project, { clientRequestId: id });
        connection.send(responseResult(id, {
          tools: [
            ...decorateTools(tools, {
              projectNames: Object.keys(this.config.aliases),
              defaultProject: connection.defaultProject,
            }),
            ...BROKER_TOOLS.filter((tool) => connection.isAdmin || !ADMIN_TOOL_NAMES.has(tool.name)),
          ],
        }));
        return;
      }
      if (method === 'tools/call') {
        const result = await this.#callTool(connection, id, params ?? {});
        connection.send(responseResult(id, result));
        return;
      }
      if (method === 'resources/list' || method === 'resources/templates/list' || method === 'prompts/list') {
        const project = this.projectByAlias(connection.defaultProject);
        const result = await this.#enqueueProtocolRead(connection, id, project, method, params ?? {});
        if (result.error) {
          if (result.error.code === -32800) {
            connection.send(responseError(id, -32800, result.error.message ?? 'Request cancelled'));
            return;
          }
          const empty = method === 'prompts/list' ? { prompts: [] }
            : method === 'resources/list' ? { resources: [] }
              : { resourceTemplates: [] };
          connection.send(responseResult(id, empty));
        } else connection.send(responseResult(id, result.result));
        return;
      }

      if (SAFE_FORWARDED_METHODS.has(method)) {
        const project = this.projectByAlias(connection.defaultProject);
        const result = await this.#enqueueProtocolRead(connection, id, project, method, params ?? {});
        if (result.error) connection.send(responseError(id, result.error.code ?? -32000, result.error.message ?? 'Unity request failed'));
        else connection.send(responseResult(id, result.result));
        return;
      }
      connection.send(responseError(id, -32601, `Unsupported MCP method: ${method}`));
    } catch (error) {
      const code = error?.code === 'CANCELLED'
        ? -32800
        : error instanceof SchedulerError ? -32080 : -32000;
      if (!connection.closed && this.connections.get(connection.id) === connection) {
        connection.send(responseError(id, code, error.message, error.code ? {
          brokerCode: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
        } : undefined));
      }
    } finally {
      connection.incomingRequests.delete(incomingRequestKey);
      connection.earlyCancellations.delete(incomingRequestKey);
    }
  }

  acknowledgeResponse(clientId, { operationId, requestId } = {}) {
    const operation = this.pendingByOperation.get(operationId);
    if (
      !operation ||
      operation.clientId !== clientId ||
      operation.requestKey !== requestKey(clientId, requestId) ||
      !operation.deliveryAckRequired
    ) {
      return Promise.resolve(false);
    }
    if (operation.deliveryDecision === 'LOST') return Promise.resolve(false);
    if (operation.deliveryDecision === 'ACK') return Promise.resolve(true);

    operation.deliveryDecision = 'ACK';
    operation.deliveryAcknowledged = true;
    this.#clearDeliveryTimer(operation);
    const tracker = this.asyncByProject.get(operation.projectKey);
    if (operation.state === 'RUNNING' && tracker?.operationId === operation.operationId) {
      tracker.deliveryUncertain = false;
      return tracker.terminalObserved
        ? this.#completeAsyncTracker(tracker).then(() => true)
        : Promise.resolve(true);
    }
    if (operation.state !== 'DELIVERING') return Promise.resolve(false);
    return this.#completeSynchronousDelivery(operation).then(() => true);
  }

  async #callTool(connection, clientRequestId, params) {
    const toolName = params.name;
    if (typeof toolName !== 'string' || !toolName) return textResult('Tool name is required.', true);
    const args = { ...(params.arguments ?? {}) };
    if (isNativeTool(toolName)) return this.#callNativeTool(connection, clientRequestId, toolName, args);
    const editorTransition = this.editorLifecycle.activeStatus?.();
    if (editorTransition) {
      return textResult(
        `Unity Editor is switching to "${editorTransition.target.project}". ` +
          `Poll unity_router_editor_use_status with ${editorTransition.operationId}.`,
        true,
        { code: 'EDITOR_TRANSITIONING', editorUse: editorTransition },
      );
    }
    const lifecycleUnknown = this.journal.list({ state: OPERATION_STATES.UNKNOWN_OUTCOME })
      .filter((operation) => operation.method === 'unity_router_editor_use' ||
        operation.method === 'unity_router_editor_open');
    if (lifecycleUnknown.length > 0) {
      return textResult(
        'Unity Editor routing is globally fenced by an unresolved handoff outcome. ' +
          'Inspect the exact Editor process and resolve every listed operation before retrying.',
        true,
        {
          code: 'EDITOR_HANDOFF_UNKNOWN_OUTCOME',
          operationIds: lifecycleUnknown.map((operation) => operation.operationId),
        },
      );
    }
    if (this.draining) {
      return textResult('Broker is drained for maintenance; no new Unity work is accepted.', true, {
        code: 'BROKER_DRAINING',
      });
    }

    const requestedAlias = args.project ?? connection.defaultProject;
    delete args.project;
    const project = this.projectByAlias(requestedAlias);
    if (!project) {
      return textResult(`Unknown project "${requestedAlias}". Configured: ${Object.keys(this.config.aliases).join(', ')}`, true);
    }
    connection.usedProjectKeys.add(project.key);

    const inactiveEditor = await this.#singleSeatInactiveProject(project);
    if (inactiveEditor) return inactiveEditor;
    if (connection.closed || this.connections.get(connection.id) !== connection) {
      throw new SchedulerError(`Request ${String(clientRequestId)} connection closed before Unity preflight`, {
        code: 'CANCELLED',
      });
    }
    const incomingRequestKey = requestKey(connection.id, clientRequestId);
    if (connection.earlyCancellations.has(incomingRequestKey)) {
      throw new SchedulerError(`Request ${String(clientRequestId)} cancelled before Unity preflight`, {
        code: 'CANCELLED',
      });
    }

    const classification = this.recovery.classify(toolName);
    const operationId = randomUUID();
    const operation = {
      kind: 'tool-call',
      operationId,
      clientId: connection.id,
      clientRequestId,
      requestKey: requestKey(connection.id, clientRequestId),
      projectKey: project.key,
      projectName: this.projectName(project),
      toolName,
      classification,
      state: 'RECEIVED',
      childRequestId: null,
      startingChild: false,
      cancelRequested: false,
      cancelAfterDispatch: false,
      connectionLost: false,
      deliveryAckRequired: false,
      deliveryAcknowledged: false,
      deliveryDecision: null,
      deliveryTimer: null,
      deliveryTransition: null,
      journalRecorded: false,
      recompileListChangedEpochAtDispatch: null,
      preflightDiscoveryWaiters: new Set(),
    };
    this.pendingByRequest.set(operation.requestKey, operation);
    this.pendingByOperation.set(operationId, operation);

    const cancelledDuringPreflight = () => operation.cancelRequested || connection.closed;
    const cancelledPreflightResult = () => {
      operation.state = 'CANCELLED';
      return textResult(`Operation ${operationId} cancelled during preflight.`, true, {
        operationId,
        state: 'CANCELLED',
      });
    };

    try {
      const unsafe = await this.#systemSafetyViolation(project, classification);
      if (cancelledDuringPreflight()) return cancelledPreflightResult();
      if (unsafe) return unsafe;

      const cli = await this.auth.compatibility(this.config.minimumCliVersion);
      if (cancelledDuringPreflight()) return cancelledPreflightResult();
      if (!cli.supported) {
        return textResult(
          `Unity CLI ${cli.actual} is unsupported. Upgrade to ${cli.minimum} or newer before starting Unity MCP work. ` +
            'This gate prevents the known pre-beta.3 permanent disconnect after Editor script recompilation.',
          true,
          { code: 'CLI_VERSION_UNSUPPORTED', ...cli },
        );
      }

      if (project.key !== connection.defaultProjectKey) {
        const defaultProject = this.config.projects.find((entry) => entry.key === connection.defaultProjectKey);
        await Promise.all([
          this.#getToolsForOperation(connection, defaultProject, operation),
          this.#getToolsForOperation(connection, project, operation),
        ]);
        if (cancelledDuringPreflight()) return cancelledPreflightResult();
        if (!this.toolRegistry.compatible(defaultProject.key, project.key, toolName)) {
          return textResult(
            `Tool schema mismatch for "${toolName}" between ${connection.defaultProject} and ${requestedAlias}. ` +
              `Register an adapter with --default ${requestedAlias} instead of overriding project.`,
            true,
          );
        }
      }

      const recoveryBlocks = [...this.recoveryFaults.values()].filter((fault) =>
        fault.projectKey == null || fault.projectKey === project.key);
      if (classification.mutation && recoveryBlocks.length > 0) {
        return textResult(
          `Mutation recovery is fenced because broker state could not be restored safely. ` +
            `Inspect operation(s): ${recoveryBlocks.map((fault) => fault.operationId).join(', ')}.`,
          true,
          { code: 'PROJECT_RECOVERY_FENCE', faults: recoveryBlocks },
        );
      }
      const unresolved = this.unknownByProject.get(project.key);
      if (classification.mutation && unresolved?.size) {
        return textResult(
          `Project "${this.projectName(project)}" is mutation-fenced by unresolved operation(s): ` +
            `${[...unresolved].join(', ')}. Inspect project state, then use unity_router_operation_resolve.`,
          true,
          { code: 'PROJECT_UNKNOWN_OUTCOME_FENCE', operationIds: [...unresolved] },
        );
      }
      const activeAsync = this.asyncByProject.get(project.key);
      if (
        classification.mutation &&
        activeAsync &&
        !activeAsync.spec.allowedMutations.includes(toolName)
      ) {
        return textResult(
          `Project "${this.projectName(project)}" has background ${activeAsync.triggerTool} ` +
            `operation ${activeAsync.operationId}. Poll ${activeAsync.spec.statusTool} until terminal.`,
          true,
          {
            code: 'PROJECT_ASYNC_OPERATION_FENCE',
            operationId: activeAsync.operationId,
            statusTool: activeAsync.spec.statusTool,
          },
        );
      }
      if (cancelledDuringPreflight()) return cancelledPreflightResult();
      if (classification.mutation) {
        await this.journal.recordReceived({
          operationId,
          project: operation.projectName,
          projectKey: operation.projectKey,
          method: toolName,
          payload: args,
        });
        operation.journalRecorded = true;
        if (operation.cancelRequested) {
          await this.journal.markCancelled(operationId);
          operation.state = 'CANCELLED';
          return textResult(`Operation ${operationId} cancelled before queueing.`, true, { operationId, state: 'CANCELLED' });
        }
        await this.journal.markQueued(operationId);
      }
      operation.state = 'QUEUED';
      if (operation.cancelRequested) {
        if (classification.mutation) await this.journal.markCancelled(operationId);
        operation.state = 'CANCELLED';
        return textResult(`Operation ${operationId} cancelled before dispatch.`, true, { operationId, state: 'CANCELLED' });
      }
      const value = await this.schedulerFor(project).enqueue({
        clientId: connection.id,
        operationId,
        classification,
        run: async (schedulerContext) => {
          operation.state = 'PREPARING';
          return this.#executeTool(connection, project, operation, args, schedulerContext);
        },
      });
      if (!['UNKNOWN_OUTCOME', 'CANCELLED', 'RUNNING', 'DELIVERING'].includes(operation.state)) {
        operation.state = 'COMPLETED';
      }
      return value;
    } catch (error) {
      if (
        classification.mutation &&
        operation.journalRecorded &&
        !['DISPATCHING', 'RUNNING', 'DELIVERING', 'UNKNOWN_OUTCOME', 'COMPLETED', 'CANCELLED']
          .includes(operation.state)
      ) {
        await this.journal.markCancelled(operationId);
        operation.state = 'CANCELLED';
      }
      if (error?.code === 'CANCELLED') return textResult(`Operation ${operationId} cancelled before dispatch.`, true, { operationId, state: 'CANCELLED' });
      throw error;
    } finally {
      this.pendingByRequest.delete(operation.requestKey);
      if (
        !classification.mutation
        || !operation.journalRecorded
        || operation.state === 'COMPLETED'
        || operation.state === 'CANCELLED'
      ) {
        this.pendingByOperation.delete(operationId);
      }
    }
  }

  async #executeTool(connection, project, operation, args, schedulerContext) {
    const classification = operation.classification;
    const acquired = [];
    let child = null;
    const identity = { ownerId: operation.operationId, sessionNonce: connection.sessionNonce };
    const remainingMs = () => Math.max(1, schedulerContext.deadlineAt - Date.now());
    const ttlMs = Math.max(60_000, remainingMs() + 60_000);
    const acquireImmediate = (key) => {
      const lease = this.leases.tryAcquire(key, { ...identity, ttlMs });
      if (!lease) throw new Error(`Required lease is unavailable: ${key}`);
      acquired.push(lease);
    };

    try {
      if (classification.mutation) {
        await this.#waitForPriorDelivery(
          project.key,
          operation.operationId,
          schedulerContext.deadlineAt,
        );
      }
      if (operation.cancelRequested) {
        if (classification.mutation) await this.journal.markCancelled(operation.operationId);
        operation.state = 'CANCELLED';
        return textResult(`Operation ${operation.operationId} cancelled before dispatch.`, true, {
          operationId: operation.operationId,
          state: 'CANCELLED',
        });
      }
      const activeAsyncAtDispatch = this.asyncByProject.get(project.key);
      const sharesTrackedAsyncLeases = Boolean(
        activeAsyncAtDispatch?.spec.allowedMutations.includes(operation.toolName),
      );
      const explicitWorkspace = this.#activeWorkspaceRecord(connection, project.key);
      if (classification.heavy && !explicitWorkspace && !sharesTrackedAsyncLeases) {
        acquireImmediate('source-refresh');
      }
      if (classification.heavy && !sharesTrackedAsyncLeases) acquireImmediate('heavy');
      if (classification.exclusive && !sharesTrackedAsyncLeases) acquireImmediate('exclusive-editor');

      const inactiveBeforeChild = await this.#singleSeatInactiveProject(project, { force: true });
      if (inactiveBeforeChild) {
        if (classification.mutation) {
          await this.journal.markCancelled(operation.operationId);
          operation.state = 'CANCELLED';
          return withOperationMetadata(
            inactiveBeforeChild,
            operation.operationId,
            'CANCELLED',
            { dispatchBlocked: true },
          );
        }
        operation.state = 'CANCELLED';
        return inactiveBeforeChild;
      }

      child = this.childFor(project);
      await this.#startChildForOperation(child, connection, operation, schedulerContext.deadlineAt);
      if (operation.cancelRequested) {
        if (classification.mutation) await this.journal.markCancelled(operation.operationId);
        operation.state = 'CANCELLED';
        return textResult(`Operation ${operation.operationId} cancelled before dispatch.`, true, {
          operationId: operation.operationId,
          state: 'CANCELLED',
        });
      }
      if (classification.mutation) {
        const dispatchViolation = await this.#dispatchSafetyViolation(project, operation);
        if (dispatchViolation) {
          if (['PROJECT_EDITOR_INACTIVE', 'EDITOR_PROCESS_AUDIT_UNSAFE',
            'EDITOR_PROCESS_AUDIT_UNAVAILABLE'].includes(dispatchViolation.structuredContent?.code)) {
            await child.stop('editor-inactive-before-dispatch').catch(() => {});
          }
          await this.journal.markCancelled(operation.operationId);
          operation.state = 'CANCELLED';
          return withOperationMetadata(
            dispatchViolation,
            operation.operationId,
            'CANCELLED',
            { dispatchBlocked: true },
          );
        }
        operation.state = 'COMMITTING';
        await this.journal.markDispatching(operation.operationId);
        if (operation.cancelRequested) {
          await this.journal.markCancelled(operation.operationId);
          operation.state = 'CANCELLED';
          return textResult(`Operation ${operation.operationId} cancelled before dispatch.`, true, {
            operationId: operation.operationId,
            state: 'CANCELLED',
          });
        }
      }
      operation.state = 'DISPATCHING';
      let retriesUsed = 0;
      for (;;) {
        if (retriesUsed > 0) {
          const inactiveBeforeRetry = await this.#singleSeatInactiveProject(project, { force: true });
          if (inactiveBeforeRetry) {
            if (classification.mutation) await this.journal.markCancelled(operation.operationId);
            operation.state = 'CANCELLED';
            return classification.mutation
              ? withOperationMetadata(
                  inactiveBeforeRetry,
                  operation.operationId,
                  'CANCELLED',
                  { dispatchBlocked: true, retryBlocked: true },
                )
              : inactiveBeforeRetry;
          }
        }
        await this.#startChildForOperation(child, connection, operation, schedulerContext.deadlineAt);
        const attemptViolation = classification.mutation
          ? await this.#dispatchSafetyViolation(project, operation)
          : await this.#singleSeatInactiveProject(project, { force: true });
        if (attemptViolation) {
          if (['PROJECT_EDITOR_INACTIVE', 'EDITOR_PROCESS_AUDIT_UNSAFE',
            'EDITOR_PROCESS_AUDIT_UNAVAILABLE'].includes(attemptViolation.structuredContent?.code)) {
            await child.stop('editor-inactive-before-attempt').catch(() => {});
          }
          if (classification.mutation) await this.journal.markCancelled(operation.operationId);
          operation.state = 'CANCELLED';
          return classification.mutation
            ? withOperationMetadata(
                attemptViolation,
                operation.operationId,
                'CANCELLED',
                { dispatchBlocked: true, retriesUsed },
              )
            : attemptViolation;
        }
        if (operation.cancelRequested) {
          if (classification.mutation) await this.journal.markCancelled(operation.operationId);
          operation.state = 'CANCELLED';
          return textResult(`Operation ${operation.operationId} cancelled before dispatch.`, true, {
            operationId: operation.operationId,
            state: 'CANCELLED',
          });
        }
        const timeoutMs = Math.min(this.config.toolTimeoutSec * 1000, Math.max(1, remainingMs()));
        if (operation.toolName === 'recompile' && operation.recompileListChangedEpochAtDispatch == null) {
          operation.recompileListChangedEpochAtDispatch = this.#childToolListChangedEpoch(project.key);
          this.recompileListChangedGenerations.set(project.key, {
            operationId: operation.operationId,
            announced: false,
            rediscovered: false,
          });
          // Each recompile is an independent refresh generation even if the
          // prior generation's catalog was never requested.
          this.toolInvalidationAnnouncements.delete(project.key);
          this.toolReannounceEpochs.delete(project.key);
        }
        const response = await child.request('tools/call', { name: operation.toolName, arguments: args }, timeoutMs, {
          connectionId: connection.id,
          operationId: operation.operationId,
          protocolVersion: connection.protocolVersion,
          clientInfo: connection.clientInfo,
          // The broker has just started and audited this exact child/Editor
          // pairing. Never let request() silently replace the child after
          // that audit; a pre-dispatch loss must return undispatched so the
          // retry path can repeat both startup and the safety audit.
          requireAlreadyStarted: true,
          deadlineAt: schedulerContext.deadlineAt,
          startupTimeoutMs: Math.min(this.config.startupTimeoutSec * 1000, Math.max(1, remainingMs())),
          isCancelled: () => operation.cancelRequested,
          onChildRequestId: (childId) => {
            operation.childRequestId = childId;
            if (operation.cancelRequested) {
              operation.cancelAfterDispatch = true;
              child.cancel(childId, 'client cancelled');
            }
          },
        });
        if (response.dispatched === true) operation.everDispatched = true;
        const failure = classifyFailure(response);
        const beforeDispatch = response.transportFailure === true && response.dispatched === false;
        const retry = !operation.cancelRequested
          && !operation.connectionLost
          && (beforeDispatch || (failure && this.recovery.canRetry(classification, retriesUsed)));
        const retryLimit = beforeDispatch ? 1 : this.config.recovery.safeReadRetries;
        if (retry && retriesUsed < retryLimit && schedulerContext.deadlineAt > Date.now()) {
          retriesUsed += 1;
          this.logger.warn('recovering retryable Unity call', {
            project: operation.projectName,
            operationId: operation.operationId,
            tool: operation.toolName,
            failure,
            beforeDispatch,
            retriesUsed,
          });
          if (failure === 'auth') await this.auth.status({ force: true });
          await child.stop('tool-retry');
          await delay(250 * retriesUsed);
          continue;
        }

        if (classification.mutation) {
          if (response.transportFailure === true && response.dispatched !== false) {
            await child.stop();
            await this.journal.markUnknownOutcome(operation.operationId);
            operation.state = 'UNKNOWN_OUTCOME';
            this.#addUnknownFence(project.key, operation.operationId);
            return textResult(
              `Mutation outcome is unknown and was not retried. Operation: ${operation.operationId}. ` +
                'Use unity_router_operation_status and inspect project state before any manual retry.',
              true,
              { operationId: operation.operationId, state: 'UNKNOWN_OUTCOME' },
            );
          }
          if (response.transportFailure === true && response.dispatched === false) {
            await this.journal.markCancelled(operation.operationId);
            operation.state = 'CANCELLED';
            return textResult(
              `Mutation was not dispatched. Operation: ${operation.operationId}.`,
              true,
              { operationId: operation.operationId, state: 'CANCELLED', code: 'NOT_DISPATCHED' },
            );
          }
          const asyncSpec = asyncSpecFor(operation.toolName, args);
          if (responseStartsAsync(asyncSpec, response)) {
            const correlation = asyncCorrelationFor(asyncSpec, response);
            if (asyncSpec.triggerTool === 'build' && !correlation) {
              await child.stop();
              await this.journal.markUnknownOutcome(operation.operationId);
              operation.state = 'UNKNOWN_OUTCOME';
              this.#addUnknownFence(project.key, operation.operationId);
              return textResult(
                `Background build started without a buildId, so it cannot be polled safely. ` +
                  `Operation: ${operation.operationId}.`,
                true,
                { operationId: operation.operationId, state: 'UNKNOWN_OUTCOME', code: 'ASYNC_CORRELATION_MISSING' },
              );
            }
            await this.journal.markRunning(operation.operationId, asyncSpec.statusTool, correlation);
            operation.state = 'RUNNING';
            this.#armDeliveryAcknowledgement(operation);
            this.#retainAsyncTracker({
              project,
              operation,
              spec: asyncSpec,
              correlation,
              leases: acquired.splice(0),
              identity,
              // Until the adapter confirms that the trigger response reached
              // its stdout pipe, a later retry cannot be proven safe.
              deliveryUncertain: !operation.deliveryAcknowledged,
            });
            return withOperationMetadata(response.result, operation.operationId, 'RUNNING', {
              statusTool: asyncSpec.statusTool,
              routerDeliveryAckRequired: true,
            });
          }
          if (operation.toolName === 'recompile') {
            this.#announceSuccessfulRecompile(
              project,
              response,
              operation.recompileListChangedEpochAtDispatch,
              operation.operationId,
            );
          }
          if (
            operation.cancelAfterDispatch &&
            (response.error || response.result?.isError === true || responseLooksCancelled(response))
          ) {
            await child.stop();
            await this.journal.markUnknownOutcome(operation.operationId);
            operation.state = 'UNKNOWN_OUTCOME';
            this.#addUnknownFence(project.key, operation.operationId);
            return textResult(
              `Mutation cancellation was acknowledged after dispatch, so its outcome is unknown. ` +
                `Operation: ${operation.operationId}. Inspect project state before resolving the fence.`,
              true,
              { operationId: operation.operationId, state: 'UNKNOWN_OUTCOME', code: 'CANCELLED_AFTER_DISPATCH' },
            );
          }
          if (operation.connectionLost) {
            await child.stop();
            await this.journal.markUnknownOutcome(operation.operationId);
            operation.state = 'UNKNOWN_OUTCOME';
            this.#addUnknownFence(project.key, operation.operationId);
            return textResult(
              `Mutation completed after its adapter disconnected, so delivery of the result is uncertain. ` +
                `Operation: ${operation.operationId}. Inspect project state before resolving the fence.`,
              true,
              { operationId: operation.operationId, state: 'UNKNOWN_OUTCOME', code: 'RESULT_DELIVERY_UNCERTAIN' },
            );
          }
          operation.state = 'DELIVERING';
          this.#armDeliveryAcknowledgement(operation);
        }

        await this.#observeAsyncResponse(project, operation.toolName, response);

        if (response.error) {
          const failureResult = textResult(`Unity request failed: ${response.error.message}`, true, {
            operationId: classification.mutation ? operation.operationId : undefined,
            state: classification.mutation ? 'COMPLETED' : undefined,
          });
          return classification.mutation
            ? withOperationMetadata(failureResult, operation.operationId, 'COMPLETED', {
                routerDeliveryAckRequired: true,
              })
            : failureResult;
        }
        return classification.mutation
          ? withOperationMetadata(response.result, operation.operationId, 'COMPLETED', {
              routerDeliveryAckRequired: true,
            })
          : response.result;
      }
    } catch (error) {
      if (
        classification.mutation &&
        this.journal.get(operation.operationId)?.state === OPERATION_STATES.DISPATCHING
      ) {
        await child?.stop().catch(() => {});
        if (operation.everDispatched) {
          await this.journal.markUnknownOutcome(operation.operationId);
          operation.state = 'UNKNOWN_OUTCOME';
          this.#addUnknownFence(project.key, operation.operationId);
        } else {
          await this.journal.markCancelled(operation.operationId);
          operation.state = 'CANCELLED';
        }
      }
      throw error;
    } finally {
      if (
        operation.toolName === 'recompile'
        && ['UNKNOWN_OUTCOME', 'CANCELLED'].includes(operation.state)
        && this.recompileListChangedGenerations.get(project.key)?.operationId === operation.operationId
      ) {
        this.recompileListChangedGenerations.delete(project.key);
      }
      for (const lease of acquired.reverse()) {
        try { this.leases.release(lease, identity); } catch { /* exact lease may already be orphaned but remains releasable */ }
      }
    }
  }

  async #getTools(connection, project, { clientRequestId } = {}) {
    if (clientRequestId === undefined) return this.#resolveTools(connection, project);

    const operationId = `tools-list-request:${randomUUID()}`;
    const operation = {
      kind: 'tools-list',
      operationId,
      clientId: connection.id,
      clientRequestId,
      requestKey: requestKey(connection.id, clientRequestId),
      projectKey: project.key,
      state: 'WAITING_DISCOVERY',
      cancelRequested: false,
      connectionLost: false,
      cancelReject: null,
      discoveryState: null,
    };
    this.pendingByRequest.set(operation.requestKey, operation);
    this.pendingByOperation.set(operationId, operation);
    const cancelled = new Promise((_, reject) => {
      operation.cancelReject = (reason = 'client cancelled') => reject(
        new SchedulerError(`Operation ${operationId} cancelled: ${reason}`, { code: 'CANCELLED' }),
      );
    });
    try {
      const resolution = this.#resolveTools(connection, project, operation);
      return await Promise.race([resolution, cancelled]);
    } finally {
      this.#releaseToolDiscoveryWaiter(operation, false);
      operation.cancelReject = null;
      this.pendingByRequest.delete(operation.requestKey);
      this.pendingByOperation.delete(operationId);
    }
  }

  async #resolveTools(connection, project, waiter = null) {
    if (waiter?.cancelRequested) {
      throw new SchedulerError('Tool discovery cancelled before safety checks', { code: 'CANCELLED' });
    }
    const unsafe = await this.#systemSafetyViolation(project, this.recovery.classify('editor_status'));
    if (waiter?.cancelRequested) {
      throw new SchedulerError('Tool discovery cancelled during safety checks', { code: 'CANCELLED' });
    }
    if (unsafe) {
      this.logger.warn('Unity tool discovery blocked by system process audit', {
        project: this.projectName(project),
        findings: unsafe.structuredContent?.findings,
      });
      return [];
    }
    if (await this.#singleSeatInactiveProject(project)) return [];
    const cli = await this.auth.compatibility(this.config.minimumCliVersion);
    if (waiter?.cancelRequested) {
      throw new SchedulerError('Tool discovery cancelled during compatibility checks', { code: 'CANCELLED' });
    }
    if (!cli.supported) return [];
    const cached = this.toolRegistry.get(project.key);
    if (cached?.tools.length) return cached.tools;
    if (waiter?.cancelRequested) {
      throw new SchedulerError('Tool discovery cancelled before queueing', { code: 'CANCELLED' });
    }
    return this.#startToolDiscovery(connection, project, {}, waiter);
  }

  async #getToolsForOperation(connection, project, operation) {
    const waiter = {
      operationId: `${operation.operationId}:tools:${project.key}`,
      cancelRequested: operation.cancelRequested,
      cancelReject: null,
      discoveryState: null,
    };
    operation.preflightDiscoveryWaiters.add(waiter);
    const cancelled = new Promise((_, reject) => {
      waiter.cancelReject = (reason = 'client cancelled') => reject(
        new SchedulerError(`Operation ${operation.operationId} tool discovery cancelled: ${reason}`, {
          code: 'CANCELLED',
        }),
      );
    });
    try {
      return await Promise.race([
        this.#resolveTools(connection, project, waiter),
        cancelled,
      ]);
    } finally {
      this.#releaseToolDiscoveryWaiter(waiter, false);
      waiter.cancelReject = null;
      operation.preflightDiscoveryWaiters.delete(waiter);
    }
  }

  #cancelOperationToolDiscoveries(operation, reason = 'client cancelled') {
    for (const waiter of operation.preflightDiscoveryWaiters ?? []) {
      if (waiter.cancelRequested) continue;
      waiter.cancelRequested = true;
      this.#releaseToolDiscoveryWaiter(waiter, true, reason);
      waiter.cancelReject?.(reason);
    }
  }

  #startToolDiscovery(connection, project, options = {}, waiter = null) {
    const existingDiscovery = this.toolDiscoveryInFlight.get(project.key);
    if (existingDiscovery) {
      if (waiter) {
        existingDiscovery.waiters.add(waiter);
        waiter.discoveryState = existingDiscovery;
      } else {
        existingDiscovery.nonCancellable = true;
      }
      return existingDiscovery.promise;
    }
    const state = {
      projectKey: project.key,
      promise: null,
      waiters: new Set(),
      nonCancellable: waiter == null,
      cancelRequested: false,
      operationId: null,
      child: null,
      childRequestId: null,
    };
    if (waiter) {
      state.waiters.add(waiter);
      waiter.discoveryState = state;
    }
    this.toolDiscoveryInFlight.set(project.key, state);
    state.promise = this.#discoverTools(connection, project, options, state).finally(() => {
      if (this.toolDiscoveryInFlight.get(project.key) === state) {
        this.toolDiscoveryInFlight.delete(project.key);
      }
    });
    return state.promise;
  }

  #releaseToolDiscoveryWaiter(operation, cancelled, reason = 'client cancelled') {
    const state = operation.discoveryState;
    if (!state) return;
    state.waiters.delete(operation);
    operation.discoveryState = null;
    if (!cancelled || state.waiters.size > 0 || state.nonCancellable || state.cancelRequested) return;
    state.cancelRequested = true;
    if (this.toolDiscoveryInFlight.get(state.projectKey) === state) {
      this.toolDiscoveryInFlight.delete(state.projectKey);
    }
    if (state.operationId) this.schedulers.get(state.projectKey)?.cancel(state.operationId, reason);
    if (state.child && state.childRequestId) {
      state.child.cancel(state.childRequestId, reason);
      void state.child.stop('discovery-cancel').catch(() => {});
    }
  }

  #cancelToolListOperation(operation, reason = 'client cancelled') {
    if (operation.cancelRequested) return;
    operation.cancelRequested = true;
    operation.state = 'CANCELLED';
    this.#releaseToolDiscoveryWaiter(operation, true, reason);
    operation.cancelReject?.(reason);
  }

  async #discoverTools(connection, project, {
    announceIfChangedAfterPriorAnnouncement = false,
    announceOnSuccessfulRediscovery = false,
  } = {}, discoveryState = null) {
    const classification = this.recovery.classify('editor_status');
    let emptyCatalogDeadlineAt = null;
    let invalidationAttempts = 0;
    let emptyCatalogRetries = 0;
    for (;;) {
      if (discoveryState?.cancelRequested) {
        throw new SchedulerError('Tool discovery cancelled before dispatch', { code: 'CANCELLED' });
      }
      if (
        emptyCatalogDeadlineAt == null
        && this.toolRegistry.get(project.key) == null
        && this.toolRegistry.hasKnownNonEmptyCatalog(project.key)
      ) {
        emptyCatalogDeadlineAt = Date.now() + Math.min(
          this.toolCatalogRecoveryGraceMs,
          this.config.queue.deadlineSec * 1_000,
        );
      }
      if (emptyCatalogDeadlineAt != null && Date.now() >= emptyCatalogDeadlineAt) {
        throw new SchedulerError(
          `Unity tool catalog for ${this.projectName(project)} is still recovering after reload`,
          { code: 'TOOL_CATALOG_RECOVERING' },
        );
      }
      const invalidationEpochAtStart = this.#toolInvalidationEpoch(project.key);
      const operationId = `tools-list:${randomUUID()}`;
      if (discoveryState) discoveryState.operationId = operationId;
      let response;
      try {
        response = await this.schedulerFor(project).enqueue({
          clientId: connection.id,
          operationId,
          classification,
          ...(emptyCatalogDeadlineAt == null ? {} : { deadlineAt: emptyCatalogDeadlineAt }),
          run: async ({ deadlineAt }) => {
            if (discoveryState?.cancelRequested) {
              throw new SchedulerError('Tool discovery cancelled before dispatch', { code: 'CANCELLED' });
            }
            const child = this.childFor(project);
            if (discoveryState) discoveryState.child = child;
            const remainingMs = () => deadlineAt - Date.now();
            const requestContext = {
              connectionId: connection.id,
              protocolVersion: connection.protocolVersion,
              clientInfo: connection.clientInfo,
              deadlineAt,
              startupTimeoutMs: Math.min(this.config.startupTimeoutSec * 1000, Math.max(1, remainingMs())),
              isCancelled: () => discoveryState?.cancelRequested === true,
              onChildRequestId: (childId) => {
                if (discoveryState) {
                  discoveryState.childRequestId = childId;
                  if (discoveryState.cancelRequested) child.cancel(childId, 'client cancelled');
                }
              },
            };
            if (remainingMs() <= 0) {
              throw new SchedulerError('Tool discovery deadline expired before dispatch', {
                code: 'DEADLINE_EXCEEDED',
              });
            }
            let result = await child.request(
              'tools/list',
              {},
              Math.min(Math.max(1, remainingMs()), this.config.startupTimeoutSec * 1000),
              requestContext,
            );
            if (discoveryState) discoveryState.childRequestId = null;
            if (discoveryState?.cancelRequested) {
              throw new SchedulerError('Tool discovery cancelled during dispatch', { code: 'CANCELLED' });
            }
            if (result.transportFailure) {
              await child.stop('discovery-retry');
              if (discoveryState?.cancelRequested) {
                throw new SchedulerError('Tool discovery cancelled before retry', { code: 'CANCELLED' });
              }
              if (remainingMs() <= 0) {
                throw new SchedulerError('Tool discovery deadline expired before retry', {
                  code: 'DEADLINE_EXCEEDED',
                });
              }
              result = await child.request(
                'tools/list',
                {},
                Math.min(Math.max(1, remainingMs()), this.config.startupTimeoutSec * 1000),
                requestContext,
              );
              if (discoveryState) discoveryState.childRequestId = null;
            }
            if (discoveryState?.cancelRequested) {
              throw new SchedulerError('Tool discovery cancelled during dispatch', { code: 'CANCELLED' });
            }
            if (result.error) throw new Error(result.error.message ?? 'tools/list failed');
            return result.result?.tools;
          },
        });
      } catch (error) {
        // Keep broker-native status/doctor tools usable while an Editor is
        // closed or still compiling. The background refresh will announce when
        // Unity tools become available instead of pinning the client to an
        // initial tools/list error.
        this.logger.debug('Unity tool discovery unavailable', {
          project: this.projectName(project),
          message: error.message,
        });
        if (error?.code === 'CANCELLED') throw error;
        if (emptyCatalogDeadlineAt != null) {
          throw new SchedulerError(
            `Unity tool catalog for ${this.projectName(project)} is still recovering after reload`,
            { code: 'TOOL_CATALOG_RECOVERING' },
          );
        }
        return [];
      }
      if (!isValidToolCatalog(response)) {
        throw new SchedulerError(
          `Unity tools/list returned a malformed catalog for ${this.projectName(project)}`,
          { code: 'INVALID_TOOL_CATALOG' },
        );
      }
      if (this.#toolInvalidationEpoch(project.key) !== invalidationEpochAtStart) {
        invalidationAttempts += 1;
        this.logger.debug('discarding tool discovery invalidated while in flight', {
          project: this.projectName(project),
          attempt: invalidationAttempts,
        });
        if (invalidationAttempts >= 2) {
          if (
            this.toolRegistry.get(project.key) == null
            && this.toolRegistry.hasKnownNonEmptyCatalog(project.key)
          ) {
            throw new SchedulerError(
              `Unity tool catalog for ${this.projectName(project)} is still recovering after reload`,
              { code: 'TOOL_CATALOG_RECOVERING' },
            );
          }
          return [];
        }
        emptyCatalogDeadlineAt = null;
        emptyCatalogRetries = 0;
        continue;
      }
      const recoveringKnownCatalog = response.length === 0
        && this.toolRegistry.get(project.key) == null
        && this.toolRegistry.hasKnownNonEmptyCatalog(project.key);
      if (recoveringKnownCatalog) {
        if (emptyCatalogDeadlineAt == null) {
          emptyCatalogDeadlineAt = Date.now() + Math.min(
            this.toolCatalogRecoveryGraceMs,
            this.config.queue.deadlineSec * 1_000,
          );
        }
        if (Date.now() < emptyCatalogDeadlineAt) {
          emptyCatalogRetries += 1;
          const waitMs = Math.min(
            this.toolCatalogRecoveryPollMs,
            Math.max(1, emptyCatalogDeadlineAt - Date.now()),
          );
          this.logger.debug('deferring transient empty Unity tool catalog after invalidation', {
            project: this.projectName(project),
            retry: emptyCatalogRetries,
            waitMs,
          });
          await delay(waitMs);
          continue;
        }
        throw new SchedulerError(
          `Unity tool catalog for ${this.projectName(project)} is still recovering after reload`,
          { code: 'TOOL_CATALOG_RECOVERING' },
        );
      }
      const update = this.toolRegistry.update(project.key, response);
      const wasAnnounced = this.toolInvalidationAnnouncements.delete(project.key);
      const reannounceIfChanged = this.toolReannounceEpochs.get(project.key)
        === invalidationEpochAtStart;
      const announceRecoveredCatalog = this.toolRecoveryAnnounceEpochs.get(project.key)
        === invalidationEpochAtStart;
      const recoveryWaitingForCatalog = announceRecoveredCatalog && response.length === 0;
      const generation = this.recompileListChangedGenerations.get(project.key);
      if (generation?.announced && response.length > 0) generation.rediscovered = true;
      if (
        !recoveryWaitingForCatalog
        && (update.changed || update.becameAvailable
          || ((announceOnSuccessfulRediscovery || announceRecoveredCatalog) && response.length > 0))
        && (!wasAnnounced || announceIfChangedAfterPriorAnnouncement || reannounceIfChanged)
      ) {
        this.#broadcastToolListChanged(project.key);
      }
      if (reannounceIfChanged) this.toolReannounceEpochs.delete(project.key);
      if (announceRecoveredCatalog && response.length > 0) {
        this.toolRecoveryAnnounceEpochs.delete(project.key);
      }
      return response;
    }
  }

  async #refreshUnavailableTools() {
    if (this.shuttingDown || this.draining || this.editorLifecycle.activeStatus?.()) return;
    await this.editorLifecycle.ready?.();
    if (this.editorLifecycle.activeStatus?.()) return;
    const work = [];
    for (const project of this.config.projects) {
      if (this.toolRegistry.get(project.key)?.tools.length) continue;
      const connection = [...this.connections.values()].find((candidate) =>
        !candidate.closed && candidate.ready && candidate.usedProjectKeys.has(project.key));
      if (!connection) continue;
      work.push(this.#getTools(connection, project));
    }
    await Promise.allSettled(work);
  }

  async #enqueueProtocolRead(connection, clientRequestId, project, method, params) {
    const operationId = `protocol:${randomUUID()}`;
    const operation = {
      kind: 'protocol-read',
      operationId,
      clientId: connection.id,
      clientRequestId,
      requestKey: requestKey(connection.id, clientRequestId),
      projectKey: project.key,
      state: 'QUEUED',
      childRequestId: null,
      startingChild: false,
      cancelRequested: false,
      connectionLost: false,
    };
    this.pendingByRequest.set(operation.requestKey, operation);
    this.pendingByOperation.set(operationId, operation);
    try {
      const response = await this.schedulerFor(project).enqueue({
        clientId: connection.id,
        operationId,
        classification: this.recovery.classify('editor_status'),
        run: async ({ deadlineAt }) => {
          operation.state = 'PREPARING';
          if (operation.cancelRequested) {
            throw new SchedulerError(`Operation ${operationId} cancelled before dispatch`, {
              code: 'CANCELLED',
            });
          }
          const child = this.childFor(project);
          await this.#startChildForOperation(child, connection, operation, deadlineAt);
          let retriesUsed = 0;
          for (;;) {
            if (operation.cancelRequested) {
              throw new SchedulerError(`Operation ${operationId} cancelled before dispatch`, {
                code: 'CANCELLED',
              });
            }
            if (Date.now() >= deadlineAt) {
              throw new SchedulerError(`Operation ${operationId} deadline expired before dispatch`, {
                code: 'DEADLINE_EXCEEDED',
              });
            }
            operation.state = 'DISPATCHING';
            const result = await child.request(method, params, Math.max(1, deadlineAt - Date.now()), {
              connectionId: connection.id,
              clientRequestId,
              protocolVersion: connection.protocolVersion,
              clientInfo: connection.clientInfo,
              deadlineAt,
              startupTimeoutMs: Math.min(
                this.config.startupTimeoutSec * 1000,
                Math.max(1, deadlineAt - Date.now()),
              ),
              isCancelled: () => operation.cancelRequested,
              onChildRequestId: (childId) => {
                operation.childRequestId = childId;
                if (operation.cancelRequested) child.cancel(childId, 'client cancelled');
              },
            });
            if (operation.cancelRequested) {
              throw new SchedulerError(`Operation ${operationId} cancelled during dispatch`, {
                code: 'CANCELLED',
              });
            }
            if (!result.transportFailure || retriesUsed >= 1 || operation.cancelRequested) {
              operation.state = 'COMPLETED';
              return result;
            }
            retriesUsed += 1;
            await child.stop('protocol-retry');
            if (operation.cancelRequested) {
              throw new SchedulerError(`Operation ${operationId} cancelled before retry`, {
                code: 'CANCELLED',
              });
            }
            if (Date.now() >= deadlineAt) {
              throw new SchedulerError(`Operation ${operationId} deadline expired before retry`, {
                code: 'DEADLINE_EXCEEDED',
              });
            }
          }
        },
      });
      return response;
    } finally {
      this.pendingByRequest.delete(operation.requestKey);
      this.pendingByOperation.delete(operationId);
    }
  }

  async #callNativeTool(connection, clientRequestId, name, args) {
    if (ADMIN_TOOL_NAMES.has(name) && !connection.isAdmin) {
      return textResult(
        `Administrative capability is required for ${name}. Use the dedicated router CLI command.`,
        true,
        { code: 'ADMIN_REQUIRED' },
      );
    }
    if (name === 'unity_auth_refresh') {
      const status = await this.auth.status({ force: true });
      return textResult(status.signedIn
        ? `Unity CLI credential is valid.\n\n${status.raw}`
        : `Unity CLI is signed out. Run \`unity auth login\` manually.\n\n${status.raw}`, !status.signedIn);
    }
    if (name === 'unity_router_status') {
      const auth = await this.auth.status();
      const snapshot = await this.snapshot({ auth, isAdmin: connection.isAdmin });
      return textResult(JSON.stringify(snapshot, null, 2), false, snapshot);
    }
    if (name === 'unity_router_editor_use') {
      const project = this.projectByAlias(args.project);
      if (!project) {
        return textResult(
          `Unknown project "${args.project}". Configured: ${Object.keys(this.config.aliases).join(', ')}`,
          true,
          { code: 'EDITOR_PROJECT_NOT_CONFIGURED' },
        );
      }
      try {
        const editorUse = await this.editorLifecycle.ensureProject(project);
        return textResult(JSON.stringify(editorUse, null, 2), false, editorUse);
      } catch (error) {
        return textResult(error.message, true, {
          code: error.code ?? 'EDITOR_HANDOFF_FAILED',
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
    }
    if (name === 'unity_router_editor_use_status') {
      const editorUse = this.editorLifecycle.status(args.operationId);
      return editorUse
        ? textResult(JSON.stringify(editorUse, null, 2), false, editorUse)
        : textResult(`Unknown Editor handoff "${args.operationId}".`, true, {
            code: 'EDITOR_HANDOFF_NOT_FOUND',
          });
    }
    if (name === 'unity_router_doctor') {
      const [processAudit, projectAccess] = await Promise.all([
        this.#processAudit({ force: true }),
        this.projectAccessAuditor.auditAll(this.config.projects, { force: true }),
      ]);
      const projectFindings = projectAccess.projects
        .filter((project) => !project.ok)
        .map((project) => ({
          severity: 'error',
          kind: 'project_access_failed',
          project: project.project,
          projectKey: project.projectKey,
          projectPath: project.projectPath,
          expectedIdentity: project.expectedIdentity,
          observedIdentity: project.observedIdentity,
          code: project.code,
          likelyCause: project.likelyCause,
          remediation: project.remediation,
        }));
      const audit = {
        ...processAudit,
        ok: processAudit.ok && projectAccess.ok,
        findings: [...(processAudit.findings ?? []), ...projectFindings],
        editors: processAudit.editors ?? [],
        processAudit,
        projectAccess,
        responsibleExecutable: projectAccess.responsibleExecutable,
      };
      return textResult(JSON.stringify(audit, null, 2), !audit.ok, audit);
    }
    if (name === 'unity_router_drain') {
      this.draining = true;
      const deadline = Date.now() + (args.timeoutSec ?? 60) * 1000;
      while (
        (this.budget.snapshot().pendingTotal > 0 || this.#allDeliveryPending().length > 0 ||
          this.editorLifecycle.activeStatus?.() != null) &&
        Date.now() < deadline
      ) await delay(25);
      const pendingTotal = this.budget.snapshot().pendingTotal;
      const deliveryPending = this.#allDeliveryPending().map((operation) => operation.operationId);
      const leases = this.#publicLeases();
      const editorUse = this.editorLifecycle.activeStatus?.() ?? null;
      const drained = pendingTotal === 0 && deliveryPending.length === 0 && leases.length === 0 && editorUse == null;
      const result = { drained, pendingTotal, deliveryPending, leases, editorUse, mutationFences: Object.fromEntries(
        [...this.unknownByProject].map(([key, values]) => [key, [...values]]),
      ) };
      return textResult(JSON.stringify(result, null, 2), !drained, result);
    }
    if (name === 'unity_router_resume') {
      this.draining = false;
      return textResult('Broker resumed.', false, { draining: false });
    }
    if (name === 'unity_router_restart') {
      const project = this.projectByAlias(args.project ?? connection.defaultProject);
      if (!project) return textResult(`Unknown project "${args.project}".`, true);
      await this.schedulerFor(project).enqueue({
        clientId: connection.id,
        operationId: `router-restart:${randomUUID()}`,
        classification: this.recovery.classify('editor_status'),
        run: async () => {
          const epochBeforeStop = this.#toolInvalidationEpoch(project.key);
          const preserveChangedOnlyReannounce = this.toolReannounceEpochs.has(project.key);
          const preserveRecoveryAnnouncement = this.toolRecoveryAnnounceEpochs.has(project.key);
          await this.children.get(project.key)?.stop('admin-restart');
          if (this.#toolInvalidationEpoch(project.key) === epochBeforeStop) {
            this.#invalidateProjectTools(project.key);
            if (preserveChangedOnlyReannounce) {
              this.toolReannounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
            }
            if (preserveRecoveryAnnouncement) {
              this.toolRecoveryAnnounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
            }
          }
        },
      });
      return textResult(`Restarted adapter state for "${this.projectName(project)}". It will reconnect lazily.`);
    }
    if (name === 'unity_router_operation_status') {
      const operation = this.journal.get(args.operationId);
      return operation
        ? textResult(JSON.stringify(operation, null, 2), false, operation)
        : textResult(`Unknown operation "${args.operationId}".`, true);
    }
    if (name === 'unity_router_operation_resolve') {
      const operation = this.journal.get(args.operationId);
      if (!operation) return textResult(`Unknown operation "${args.operationId}".`, true);
      if (![OPERATION_STATES.UNKNOWN_OUTCOME, OPERATION_STATES.RUNNING].includes(operation.state)) {
        return textResult(
          `Operation "${args.operationId}" is ${operation.state}, not RUNNING or UNKNOWN_OUTCOME.`,
          true,
        );
      }
      if (operation.state === OPERATION_STATES.RUNNING) {
        if (args.resolution === 'safe_to_retry') {
          return textResult('A RUNNING operation can never be marked safe_to_retry.', true, {
            code: 'RUNNING_RETRY_FORBIDDEN',
          });
        }
        if (args.confirmNoLongerRunning !== true) {
          return textResult(
            'confirmNoLongerRunning=true is required after independently verifying the background operation is terminal.',
            true,
            { code: 'RUNNING_TERMINAL_CONFIRMATION_REQUIRED' },
          );
        }
      }
      let editorOpenResolution = null;
      if (operation.method === 'unity_router_editor_use' && args.resolution === 'confirmed_completed') {
        const childOperationId = `${args.operationId}:open`;
        const childOperation = this.journal.get(childOperationId);
        const isExactOpenChild = childOperation?.method === 'unity_router_editor_open'
          && childOperation.projectKey === operation.projectKey
          && [OPERATION_STATES.RUNNING, OPERATION_STATES.UNKNOWN_OUTCOME].includes(childOperation.state);
        if (isExactOpenChild) {
          // Resolve the internal open record first. If durable append fails,
          // the canonical parent UUID remains unresolved and the supported
          // admin command can be retried without stranding an unaddressable
          // `${parent}:open` fence.
          editorOpenResolution = await this.journal.markResolved(childOperationId, args.resolution);
        }
      }
      const resolved = await this.journal.markResolved(args.operationId, args.resolution);
      for (const tracker of this.asyncByProject.values()) {
        if (tracker.operationId === args.operationId) this.#releaseAsyncResources(tracker);
      }
      for (const [projectKey, operationIds] of this.unknownByProject) {
        operationIds.delete(args.operationId);
        if (operationIds.size === 0) this.unknownByProject.delete(projectKey);
      }
      if (editorOpenResolution) {
        for (const [projectKey, operationIds] of this.unknownByProject) {
          operationIds.delete(editorOpenResolution.operationId);
          if (operationIds.size === 0) this.unknownByProject.delete(projectKey);
        }
        this.pendingByOperation.delete(editorOpenResolution.operationId);
        this.recoveryFaults.delete(editorOpenResolution.operationId);
      }
      this.pendingByOperation.delete(args.operationId);
      this.recoveryFaults.delete(args.operationId);
      const result = editorOpenResolution
        ? { ...resolved, editorOpenResolution }
        : resolved;
      return textResult(JSON.stringify(result, null, 2), false, result);
    }
    if (name === 'unity_router_workspace_begin') {
      if (this.draining) return textResult('Broker is draining; refusing a new workspace lease.', true, { code: 'BROKER_DRAINING' });
      const project = this.projectByAlias(args.project ?? connection.defaultProject);
      if (!project) return textResult(`Unknown project "${args.project}".`, true);
      const unsafe = await this.#systemSafetyViolation(
        project,
        this.recovery.classify('eval'),
        { force: true },
      );
      if (unsafe) return unsafe;
      const existing = connection.workspaceLeases.get(project.key);
      if (existing) return textResult(JSON.stringify(existing, null, 2), false, existing);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('workspace lease deadline exceeded'), this.config.queue.deadlineSec * 1000);
      const handle = this.leases.acquire('source-refresh', {
        ownerId: connection.id,
        sessionNonce: connection.sessionNonce,
        ttlMs: (args.ttlSec ?? 600) * 1000,
        signal: controller.signal,
      });
      const key = requestKey(connection.id, clientRequestId);
      connection.pendingLeaseRequests.set(key, handle);
      let lease;
      try {
        lease = await handle;
      } finally {
        clearTimeout(timer);
        connection.pendingLeaseRequests.delete(key);
      }
      if (connection.closed) {
        this.leases.release(lease, { ownerId: connection.id, sessionNonce: connection.sessionNonce });
        return textResult('Workspace lease requester disconnected before grant.', true);
      }
      let postGrantUnsafe;
      try {
        postGrantUnsafe = await this.#systemSafetyViolation(
          project,
          this.recovery.classify('eval'),
          { force: true },
        );
      } catch (error) {
        this.leases.release(lease, { ownerId: connection.id, sessionNonce: connection.sessionNonce });
        throw error;
      }
      if (postGrantUnsafe) {
        this.leases.release(lease, { ownerId: connection.id, sessionNonce: connection.sessionNonce });
        return postGrantUnsafe;
      }
      if (connection.closed) {
        this.leases.release(lease, { ownerId: connection.id, sessionNonce: connection.sessionNonce });
        return textResult('Workspace lease requester disconnected during the post-grant safety audit.', true);
      }
      const record = this.workspaceStore.create({
        token: lease.token,
        projectKey: project.key,
        projectName: this.projectName(project),
        ownerId: connection.id,
        sessionNonce: connection.sessionNonce,
        acquiredAt: lease.acquiredAt,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
      });
      let durabilityError = null;
      try {
        await this.workspaceStore.upsert(record);
      } catch (error) {
        if (!error.committed) {
          this.leases.release(lease, { ownerId: connection.id, sessionNonce: connection.sessionNonce });
          throw error;
        }
        durabilityError = error;
      }
      const restored = { ...record, internalLease: lease, editorUseOperationId: null };
      this.workspaceRecords.set(record.token, restored);
      let editorUse = null;
      try {
        if (durabilityError) throw durabilityError;
        if (this.config.editorHandoff.mode !== 'disabled') {
          editorUse = await this.editorLifecycle.ensureProject(project);
          restored.editorUseOperationId = editorUse.operationId;
        }
      } catch (error) {
        editorUse = {
          operationId: null,
          target: {
            project: this.projectName(project),
            projectKey: project.key,
            projectPath: project.path,
          },
          state: EDITOR_HANDOFF_STATES.BLOCKED,
          blockers: [error.code ?? 'EDITOR_HANDOFF_FAILED'],
          message: error.message,
          mode: this.config.editorHandoff.mode,
        };
      }
      const value = { ...this.#workspaceSnapshot(restored), editorUse };
      // The adapter can reconnect with the same stable client/session while
      // the durable upsert is in flight. Attach the lease to the current
      // connection, not the stale socket-owned object that began the request.
      const currentConnection = this.connections.get(connection.id);
      const sameOwnerConnection = currentConnection &&
        !currentConnection.closed &&
        currentConnection.sessionNonce === record.sessionNonce;
      if (sameOwnerConnection) currentConnection.workspaceLeases.set(project.key, value);
      if (durabilityError) return this.#workspaceDurabilityFailure(durabilityError, value);
      if (!sameOwnerConnection) {
        this.logger.warn('workspace lease persisted after requester session changed', {
          project: record.projectName,
          token: record.token,
        });
        return textResult(
          'Workspace lease was durably acquired after its requester disconnected or changed session. ' +
            'The source-refresh fence remains held and requires the same session or explicit admin reconciliation.',
          true,
          { code: 'WORKSPACE_LEASE_DELIVERY_UNCERTAIN', workspace: value },
        );
      }
      return textResult(JSON.stringify(value, null, 2), false, value);
    }
    if (name === 'unity_router_workspace_heartbeat') {
      const record = this.#ownedWorkspaceRecord(args.leaseToken, connection);
      const project = this.config.projects.find((entry) => entry.key === record.projectKey);
      if (!project) {
        return textResult(`Workspace lease project is no longer configured: ${record.projectName}.`, true, {
          code: 'WORKSPACE_PROJECT_NOT_CONFIGURED',
        });
      }
      const unsafe = await this.#systemSafetyViolation(
        project,
        this.recovery.classify('eval'),
        { force: true },
      );
      if (unsafe) return unsafe;
      const lease = this.leases.heartbeat(record.internalLease, {
        ownerId: record.ownerId,
        sessionNonce: record.sessionNonce,
        ttlMs: (args.ttlSec ?? 600) * 1000,
      });
      const updated = {
        ...record,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
        internalLease: lease,
      };
      let durabilityError = null;
      try { await this.workspaceStore.upsert(updated); }
      catch (error) {
        if (!error.committed) throw error;
        durabilityError = error;
      }
      this.workspaceRecords.set(record.token, updated);
      const value = this.#workspaceSnapshot(updated);
      connection.workspaceLeases.set(record.projectKey, value);
      if (durabilityError) return this.#workspaceDurabilityFailure(durabilityError, value);
      return textResult(JSON.stringify(value, null, 2), false, value);
    }
    if (name === 'unity_router_workspace_end') {
      const record = this.#ownedWorkspaceRecord(args.leaseToken, connection);
      const editorUse = record.editorUseOperationId
        ? this.editorLifecycle.status(record.editorUseOperationId)
        : this.editorLifecycle.activeStatus?.();
      if (editorUse && !EDITOR_HANDOFF_TERMINAL_STATES.has(editorUse.state)) {
        return textResult(
          `Validation turn cannot end while Editor handoff ${editorUse.operationId} is ${editorUse.state}.`,
          true,
          {
            code: 'WORKSPACE_EDITOR_HANDOFF_ACTIVE',
            editorUse,
          },
        );
      }
      const activeAsync = this.asyncByProject.get(record.projectKey);
      if (activeAsync) {
        return textResult(
          `Workspace lease cannot end while ${activeAsync.triggerTool} operation ` +
            `${activeAsync.operationId} is still running. Keep heartbeating and retry after terminal status.`,
          true,
          {
            code: 'WORKSPACE_ASYNC_ACTIVE',
            operationId: activeAsync.operationId,
            statusTool: activeAsync.spec.statusTool,
          },
        );
      }
      // Commit the durable fence removal before releasing in-memory capacity.
      // A failed disk write must never let a second writer enter.
      try { await this.workspaceStore.remove(record.token); }
      catch (error) {
        if (error.committed) return this.#workspaceDurabilityFailure(error, this.#workspaceSnapshot(record));
        throw error;
      }
      this.leases.release(record.internalLease, {
        ownerId: record.ownerId,
        sessionNonce: record.sessionNonce,
      });
      this.workspaceRecords.delete(record.token);
      for (const [projectKey, value] of connection.workspaceLeases) {
        if (value.token === args.leaseToken) connection.workspaceLeases.delete(projectKey);
      }
      const value = { token: record.token, project: record.projectName, state: 'RELEASED' };
      return textResult(JSON.stringify(value, null, 2), false, value);
    }
    if (name === 'unity_router_workspace_resolve') {
      if (args.confirm !== true) return textResult('Refused: confirm=true is required.', true);
      const record = this.workspaceRecords.get(args.leaseToken);
      if (!record) return textResult(`Unknown workspace lease "${args.leaseToken}".`, true);
      const editorUse = record.editorUseOperationId
        ? this.editorLifecycle.status(record.editorUseOperationId)
        : this.editorLifecycle.activeStatus?.();
      if (editorUse && !EDITOR_HANDOFF_TERMINAL_STATES.has(editorUse.state)) {
        return textResult(
          `Cannot resolve validation turn while Editor handoff ${editorUse.operationId} is ${editorUse.state}.`,
          true,
          { code: 'WORKSPACE_EDITOR_HANDOFF_ACTIVE', editorUse },
        );
      }
      const activeAsync = this.asyncByProject.get(record.projectKey);
      if (activeAsync) {
        return textResult(
          `Cannot resolve workspace lease while operation ${activeAsync.operationId} is RUNNING.`,
          true,
          { code: 'WORKSPACE_ASYNC_ACTIVE', operationId: activeAsync.operationId },
        );
      }
      // Keep the live lease held if the durable reconciliation cannot commit.
      try { await this.workspaceStore.remove(record.token); }
      catch (error) {
        if (error.committed) return this.#workspaceDurabilityFailure(error, this.#workspaceSnapshot(record));
        throw error;
      }
      this.leases.release(record.internalLease, {
        ownerId: record.ownerId,
        sessionNonce: record.sessionNonce,
      });
      this.workspaceRecords.delete(record.token);
      for (const attached of this.connections.values()) attached.workspaceLeases.delete(record.projectKey);
      return textResult(`Released persisted workspace fence for "${record.projectName}".`, false, {
        token: record.token,
        project: record.projectName,
        state: 'RESOLVED',
      });
    }
    return textResult(`Unknown broker tool "${name}".`, true);
  }

  #cancelClientRequest(connection, params) {
    const key = requestKey(connection.id, params?.requestId);
    const operation = this.pendingByRequest.get(key);
    if (!operation) {
      const handle = connection.pendingLeaseRequests.get(key);
      try { handle?.cancel(params?.reason); } catch { /* exact handle may already be granted */ }
      if (!handle && connection.incomingRequests.has(key)) {
        connection.earlyCancellations.set(key, params?.reason ?? 'client cancelled');
      }
      return;
    }
    if (operation.kind === 'tools-list') {
      this.#cancelToolListOperation(operation, params?.reason);
      return;
    }
    const scheduler = this.schedulers.get(operation.projectKey);
    operation.cancelRequested = true;
    this.#cancelOperationToolDiscoveries(operation, params?.reason);
    if (this.#abortStartingChild(operation, params?.reason)) return;
    if (operation.state === 'RECEIVED' || operation.state === 'PREPARING' || operation.state === 'COMMITTING') return;
    if (operation.state === 'QUEUED' && scheduler?.cancel(operation.operationId, params?.reason)) {
      // Keep the in-memory state QUEUED until #callTool's rejection path has
      // durably appended CANCELLED. Marking it early caused the catch path to
      // skip the journal transition and left a permanent non-terminal record.
      return;
    }
    if (operation.state === 'DISPATCHING' && operation.childRequestId) {
      operation.cancelAfterDispatch = true;
      this.children.get(operation.projectKey)?.cancel(operation.childRequestId, params?.reason);
      operation.cancelRequested = true;
    }
  }

  #onChildNotification(project, message, context) {
    if (message.method === 'notifications/tools/list_changed') {
      this.childToolListChangedEpochs.set(
        project.key,
        this.#childToolListChangedEpoch(project.key) + 1,
      );
      const generation = this.recompileListChangedGenerations.get(project.key);
      this.#invalidateProjectTools(project.key);
      if (generation && !generation.announced) {
        generation.announced = true;
        this.toolInvalidationAnnouncements.add(project.key);
        this.#broadcastToolListChanged(project.key);
      } else if (generation?.rediscovered) {
        // The client may have fetched too early after the synthetic signal.
        // Reconcile silently and only emit again if the actual schema changed;
        // an unchanged catalog proves this was the same reload event.
        this.toolInvalidationAnnouncements.add(project.key);
        this.toolReannounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
        const connection = [...this.connections.values()].find((candidate) =>
          !candidate.closed && candidate.ready && candidate.usedProjectKeys.has(project.key));
        if (connection) {
          void this.#startToolDiscovery(connection, project, {
            announceIfChangedAfterPriorAnnouncement: true,
          });
        }
      } else if (!generation && !this.toolInvalidationAnnouncements.has(project.key)) {
        this.toolInvalidationAnnouncements.add(project.key);
        this.#broadcastToolListChanged(project.key);
      }
      return;
    }
    // Unity/Pipeline notifications can arrive after the request that caused
    // them has completed. Routing such an uncorrelated frame to whichever
    // client happens to be active next would leak progress/log data across
    // Codex and Claude sessions. Until a notification carries a broker-owned
    // correlation token, drop it; tools/list_changed is project-global and is
    // handled explicitly above.
    this.logger.debug('uncorrelated child notification dropped', {
      project: this.projectName(project),
      method: message?.method,
      hadActiveContext: Boolean(context?.connectionId),
    });
  }

  #onChildLifecycle(project, event) {
    if (event.expected) {
      if (event.expectedReason === 'shutdown') return;
      const preserveChangedOnlyReannounce = this.toolReannounceEpochs.has(project.key);
      const preserveRecoveryAnnouncement = this.toolRecoveryAnnounceEpochs.has(project.key);
      this.#invalidateProjectTools(project.key);
      if (preserveChangedOnlyReannounce) {
        this.toolReannounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
      }
      if (preserveRecoveryAnnouncement) {
        this.toolRecoveryAnnounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
      }
      if (event.expectedReason === 'idle') this.toolInvalidationAnnouncements.delete(project.key);
      this.logger.info('expected Unity MCP child replacement invalidated cached tools', {
        project: this.projectName(project),
        processGeneration: event.processGeneration,
        reason: event.expectedReason,
      });
      return;
    }
    const generation = this.recompileListChangedGenerations.get(project.key);
    const preserveChangedOnlyReannounce = this.toolReannounceEpochs.has(project.key);
    const alreadyAnnounced = generation?.announced === true
      || this.toolInvalidationAnnouncements.has(project.key);
    this.#invalidateProjectTools(project.key);
    if (preserveChangedOnlyReannounce) {
      this.toolReannounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
    }
    if (alreadyAnnounced) {
      this.toolInvalidationAnnouncements.add(project.key);
    } else {
      this.toolInvalidationAnnouncements.delete(project.key);
      this.toolRecoveryAnnounceEpochs.set(project.key, this.#toolInvalidationEpoch(project.key));
    }
    this.logger.warn('Unity MCP child lifecycle invalidated cached tools', {
      project: this.projectName(project),
      kind: event.kind,
      processGeneration: event.processGeneration,
    });
    const connection = [...this.connections.values()].find((candidate) =>
      !candidate.closed && candidate.ready && candidate.usedProjectKeys.has(project.key));
    if (!connection) return;
    void this.#startToolDiscovery(connection, project);
  }

  #broadcastToolListChanged(projectKey) {
    for (const connection of this.connections.values()) {
      if (!connection.ready || !connection.usedProjectKeys.has(projectKey)) continue;
      connection.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    }
  }

  #childToolListChangedEpoch(projectKey) {
    return this.childToolListChangedEpochs.get(projectKey) ?? 0;
  }

  #toolInvalidationEpoch(projectKey) {
    return this.toolInvalidationEpochs.get(projectKey) ?? 0;
  }

  #invalidateProjectTools(projectKey) {
    this.toolInvalidationEpochs.set(projectKey, this.#toolInvalidationEpoch(projectKey) + 1);
    this.toolReannounceEpochs.delete(projectKey);
    this.toolRecoveryAnnounceEpochs.delete(projectKey);
    return this.toolRegistry.invalidate(projectKey);
  }

  #announceSuccessfulRecompile(project, response, epochAtDispatch, operationId = null) {
    const generation = this.recompileListChangedGenerations.get(project.key);
    if (!isSuccessfulRecompileCompletion(response)) {
      if (generation?.operationId === operationId) {
        this.recompileListChangedGenerations.delete(project.key);
      }
      return false;
    }
    if (!Number.isSafeInteger(epochAtDispatch)) return false;
    // The official child can emit list_changed before its final recompile
    // response. That notification has already invalidated this exact project
    // and reached its users, so emitting again here would be a duplicate.
    if (generation?.operationId === operationId && generation.announced) return false;
    if (this.#childToolListChangedEpoch(project.key) !== epochAtDispatch) return false;
    const invalidation = this.#invalidateProjectTools(project.key);
    if (generation?.operationId === operationId) generation.announced = true;
    this.toolInvalidationAnnouncements.add(project.key);
    this.#broadcastToolListChanged(project.key);
    return invalidation.newlyInvalidated || generation?.operationId === operationId;
  }

  #onEditorLifecycleState(snapshot) {
    if (snapshot?.state !== EDITOR_HANDOFF_STATES.COMPLETED ||
        this.editorHandoffAnnouncements.has(snapshot.operationId)) return;
    this.editorHandoffAnnouncements.add(snapshot.operationId);
    for (const project of this.config.projects) {
      this.#invalidateProjectTools(project.key);
      this.#broadcastToolListChanged(project.key);
    }
    this.logger.info('Editor handoff completed and project catalogs were invalidated', {
      operationId: snapshot.operationId,
      project: snapshot.target?.project,
      projectPath: snapshot.target?.projectPath,
    });
  }

  async #singleSeatInactiveProject(project, { force = false } = {}) {
    if (this.config.license.mode !== 'single-seat') return null;
    const audit = await this.#processAudit({ force });
    const errorFindings = Array.isArray(audit?.findings)
      ? audit.findings.filter((finding) => finding?.severity === 'error')
      : [];
    if (audit?.ok !== true || errorFindings.length > 0 || !Array.isArray(audit?.editors)) {
      const unavailable = audit?.findings?.some((finding) => finding.kind === 'process_audit_failed');
      return textResult(
        'Unity Editor process identity is not clean, so a project child will not be started.',
        true,
        {
          code: unavailable ? 'EDITOR_PROCESS_AUDIT_UNAVAILABLE' : 'EDITOR_PROCESS_AUDIT_UNSAFE',
          findings: audit?.findings ?? [],
        },
      );
    }
    const exact = audit.editors.find((editor) => editor.projectPath === project.path);
    if (exact && audit.editors.length === 1) return null;
    const active = audit.editors.length === 1 ? audit.editors[0] : null;
    return textResult(
      active
        ? `The single licensed Unity Editor is active for "${active.projectPath}", not "${project.path}". ` +
          `Acquire a validation turn or run the admin editor-use command before calling project tools.`
        : `No Unity Editor is active for "${project.path}". Acquire a validation turn or run the admin ` +
          `editor-use command before calling project tools.`,
      true,
      {
        code: 'PROJECT_EDITOR_INACTIVE',
        targetProject: this.projectName(project),
        targetProjectPath: project.path,
        activeEditor: active,
      },
    );
  }

  #editorSwitchBlockers(project) {
    const blockers = [];
    if (this.draining) blockers.push('BROKER_DRAINING');
    const budget = this.budget.snapshot();
    if (budget.pendingTotal > 0) blockers.push('BROKER_QUEUE_NOT_IDLE');
    if (this.#allDeliveryPending().length > 0) blockers.push('DELIVERY_ACK_PENDING');
    if (this.asyncByProject.size > 0) blockers.push('BACKGROUND_OPERATION_ACTIVE');
    if (this.recoveryFaults.size > 0) blockers.push('BROKER_RECOVERY_FENCE');
    if (this.journal.list({ state: OPERATION_STATES.UNKNOWN_OUTCOME }).length > 0) {
      blockers.push('UNKNOWN_OUTCOME_FENCE');
    }

    const workspace = [...this.workspaceRecords.values()];
    const matchingWorkspace = workspace.length === 1 && workspace[0].projectKey === project.key;
    const leases = this.leases.list();
    const allowedWorkspaceLease = matchingWorkspace
      ? workspace[0].internalLease?.token
      : null;
    if (leases.some((lease) => lease.token !== allowedWorkspaceLease)) {
      blockers.push('GLOBAL_LEASE_ACTIVE');
    }
    if (workspace.length > 0 && !matchingWorkspace) blockers.push('OTHER_PROJECT_VALIDATION_TURN');
    return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
  }

  async #callEditorLifecycleTool(project, name, args, timeoutMs) {
    const child = this.childFor(project);
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    const clientInfo = { name: 'unity-mcp-router-editor-lifecycle', version: SERVER_VERSION };
    await child.start(PROTOCOL_VERSION, clientInfo, {
      connectionId: 'editor-lifecycle',
      clientRequestId: name,
      protocolVersion: PROTOCOL_VERSION,
      clientInfo,
      deadlineAt,
      startupTimeoutMs: Math.min(this.config.startupTimeoutSec * 1000, timeoutMs),
    });
    const response = await child.request('tools/call', { name, arguments: args }, timeoutMs, {
      connectionId: 'editor-lifecycle',
      clientRequestId: name,
      protocolVersion: PROTOCOL_VERSION,
      clientInfo,
      requireAlreadyStarted: true,
      deadlineAt,
      startupTimeoutMs: Math.min(this.config.startupTimeoutSec * 1000, timeoutMs),
    });
    if (response.transportFailure || response.error) {
      const error = new Error(response.error?.message ?? `Unity lifecycle tool ${name} failed`);
      error.code = String(response.error?.code ?? 'EDITOR_LIFECYCLE_TRANSPORT_FAILED');
      error.dispatched = response.dispatched;
      throw error;
    }
    if (response.result?.isError === true) {
      const detail = lifecycleToolErrorText(response.result);
      const error = new Error(detail || `Unity lifecycle tool ${name} returned an error result`);
      error.code = response.result?.structuredContent?.code ?? 'EDITOR_LIFECYCLE_TOOL_ERROR';
      error.toolName = name;
      throw error;
    }
    return response.result;
  }

  async #openEditorProject(project) {
    const unityBin = project.unityBin ?? this.config.unityBin;
    const timeout = Math.min(60_000, this.config.editorHandoff.startupTimeoutSec * 1000);
    const args = [
      ...(this.config.unityArgs ?? []),
      '--non-interactive',
      '--format',
      'json',
      'open',
      project.path,
    ];
    this.logger.info('dispatching exact Unity Editor open', {
      project: this.projectName(project),
      projectPath: project.path,
    });
    return execFileBounded(unityBin, args, {
      env: this.env,
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  }

  async snapshot({ auth, isAdmin = false } = {}) {
    const version = await this.auth.version();
    const compatibility = await this.auth.compatibility(this.config.minimumCliVersion);
    const unknown = this.journal.list({ state: OPERATION_STATES.UNKNOWN_OUTCOME });
    const processAudit = await this.#processAudit();
    const projectAccess = this.projectAccessAuditor.snapshot();
    const accessByKey = new Map(projectAccess.projects.map((entry) => [entry.projectKey, entry]));
    return {
      broker: {
        id: this.brokerId,
        pid: process.pid,
        executable: process.execPath,
        version: SERVER_VERSION,
        buildId: BUILD_INFO.buildId,
        configHash: this.configHash,
        draining: this.draining,
        clients: this.connections.size,
        configPath: this.config.configPath,
      },
      unity: {
        binary: this.config.unityBin,
        version,
        minimumVersion: this.config.minimumCliVersion,
        supported: compatibility.supported,
        signedIn: auth?.signedIn ?? null,
      },
      budget: this.budget.snapshot(),
      editorHandoff: {
        mode: this.config.editorHandoff.mode,
        active: this.editorLifecycle.activeStatus?.() ?? null,
      },
      leases: this.#publicLeases(),
      workspaceLeases: [...this.workspaceRecords.values()].map((record) => {
        const value = this.#workspaceSnapshot(record);
        if (isAdmin) return value;
        const { token, ...publicValue } = value;
        return publicValue;
      }),
      workspaceStore: this.workspaceStore.health(),
      unknownOutcomes: unknown,
      recoveryFaults: [...this.recoveryFaults.values()],
      processAudit,
      projectAccess,
      projects: this.config.projects.map((project) => ({
        name: this.projectName(project),
        aliases: project.aliases,
        path: project.path,
        access: accessByKey.get(project.key) ?? null,
        child: this.children.get(project.key)?.snapshot() ?? { state: 'OFFLINE', pid: null },
        scheduler: this.schedulers.get(project.key)?.snapshot() ?? null,
        tools: this.toolRegistry.get(project.key)?.fingerprint ?? null,
        mutationFence: [...(this.unknownByProject.get(project.key) ?? [])],
        backgroundOperation: this.asyncByProject.has(project.key)
          ? {
              operationId: this.asyncByProject.get(project.key).operationId,
              triggerTool: this.asyncByProject.get(project.key).triggerTool,
              statusTool: this.asyncByProject.get(project.key).spec.statusTool,
              correlation: this.asyncByProject.get(project.key).correlation,
              correlationFault: this.asyncByProject.get(project.key).correlationFault,
              recovered: this.asyncByProject.get(project.key).recovered,
              deliveryUncertain: this.asyncByProject.get(project.key).deliveryUncertain,
              terminalObserved: this.asyncByProject.get(project.key).terminalObserved,
            }
          : null,
        deliveryPending: this.#deliveryPendingForProject(project.key)
          .map((operation) => operation.operationId),
      })),
    };
  }

  async close() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    if (this.toolRefreshTimer) clearInterval(this.toolRefreshTimer);
    this.toolRefreshTimer = null;
    await this.editorLifecycle.close();
    for (const tracker of this.asyncByProject.values()) {
      if (tracker.timer) clearTimeout(tracker.timer);
      tracker.timer = null;
    }
    for (const operation of this.pendingByOperation.values()) this.#clearDeliveryTimer(operation);
    await Promise.allSettled(
      [...this.pendingByOperation.values()]
        .map((operation) => operation.deliveryTransition)
        .filter(Boolean),
    );
    for (const scheduler of this.schedulers.values()) scheduler.close('broker shutting down');
    await Promise.all([...this.children.values()].map((child) => child.stop('shutdown').catch(() => {})));
    await this.projectAccessAuditor.close();
    this.leases.close({ cancelQueued: true });
    await this.journal.close();
    await this.workspaceStore.close();
    this.logger.info('broker core closed');
  }

  #addUnknownFence(projectKey, operationId) {
    if (!this.unknownByProject.has(projectKey)) this.unknownByProject.set(projectKey, new Set());
    this.unknownByProject.get(projectKey).add(operationId);
  }

  #allDeliveryPending() {
    return [...this.pendingByOperation.values()]
      .filter((operation) => operation.state === 'DELIVERING');
  }

  #deliveryPendingForProject(projectKey) {
    return this.#allDeliveryPending()
      .filter((operation) => operation.projectKey === projectKey);
  }

  async #waitForPriorDelivery(projectKey, operationId, deadlineAt) {
    while (
      this.#deliveryPendingForProject(projectKey)
        .some((operation) => operation.operationId !== operationId) &&
      Date.now() < deadlineAt
    ) {
      await delay(Math.min(10, Math.max(1, deadlineAt - Date.now())));
    }
  }

  #clearDeliveryTimer(operation) {
    if (operation?.deliveryTimer) clearTimeout(operation.deliveryTimer);
    if (operation) operation.deliveryTimer = null;
  }

  #armDeliveryAcknowledgement(operation) {
    operation.deliveryAckRequired = true;
    operation.deliveryAcknowledged = false;
    if (operation.connectionLost) {
      operation.deliveryDecision = 'LOST';
      return;
    }
    operation.deliveryDecision = null;
    this.#clearDeliveryTimer(operation);
    operation.deliveryTimer = setTimeout(() => {
      operation.deliveryTimer = null;
      if (operation.deliveryDecision != null) return;
      if (operation.state === 'RUNNING') {
        operation.deliveryDecision = 'LOST';
        const tracker = this.asyncByProject.get(operation.projectKey);
        if (tracker?.operationId === operation.operationId) {
          tracker.deliveryUncertain = true;
          if (tracker.terminalObserved) {
            void this.#completeAsyncTracker(tracker).catch((error) => {
              this.draining = true;
              this.logger.error('terminal async operation could not be fenced after response ACK timeout', {
                operationId: operation.operationId,
                message: error.message,
              });
            });
          }
        }
        this.logger.warn('async trigger response acknowledgement timed out', {
          operationId: operation.operationId,
          project: operation.projectName,
        });
      } else if (operation.state === 'DELIVERING') {
        this.#loseSynchronousDelivery(operation, 'adapter response acknowledgement timed out');
      }
    }, DELIVERY_ACK_TIMEOUT_MS);
    operation.deliveryTimer.unref();
  }

  #completeSynchronousDelivery(operation) {
    if (operation.deliveryTransition) return operation.deliveryTransition;
    const transition = (async () => {
      if (this.journal.get(operation.operationId)?.state === OPERATION_STATES.DISPATCHING) {
        await this.journal.markCompleted(operation.operationId);
      }
      operation.state = 'COMPLETED';
      this.pendingByOperation.delete(operation.operationId);
    })();
    operation.deliveryTransition = transition;
    void transition.catch((error) => {
      this.draining = true;
      this.logger.error('response acknowledgement could not be journaled; broker drained', {
        operationId: operation.operationId,
        message: error.message,
      });
    });
    return transition;
  }

  #loseSynchronousDelivery(operation, reason) {
    if (operation.deliveryDecision === 'ACK') return operation.deliveryTransition;
    if (operation.deliveryDecision === 'LOST' && operation.deliveryTransition) {
      return operation.deliveryTransition;
    }
    operation.deliveryDecision = 'LOST';
    this.#clearDeliveryTimer(operation);
    const transition = (async () => {
      if (this.journal.get(operation.operationId)?.state === OPERATION_STATES.DISPATCHING) {
        await this.journal.markUnknownOutcome(operation.operationId);
      }
      operation.state = 'UNKNOWN_OUTCOME';
      this.#addUnknownFence(operation.projectKey, operation.operationId);
      this.logger.warn('mutation response delivery was not acknowledged', {
        operationId: operation.operationId,
        project: operation.projectName,
        reason,
      });
    })();
    operation.deliveryTransition = transition;
    void transition.catch((error) => {
      this.draining = true;
      this.logger.error('lost response could not be fenced durably; broker drained', {
        operationId: operation.operationId,
        message: error.message,
      });
    });
    return transition;
  }

  #addRecoveryFault(operation, code, project = null, details = {}) {
    const fault = Object.freeze({
      operationId: operation.operationId,
      state: operation.state,
      method: operation.method,
      project: operation.project,
      projectKey: project?.key ?? null,
      code,
      ...details,
    });
    this.recoveryFaults.set(operation.operationId, fault);
    this.logger.error('operation recovery fenced', fault);
  }

  #projectForJournalOperation(operation) {
    if (operation.projectKey) {
      // A v2 stable identity mismatch must never fall back to a recycled
      // display alias that may now point at a different physical checkout.
      return this.config.projects.find((entry) => entry.key === operation.projectKey) ?? null;
    }
    return this.config.projects.find((entry) =>
      this.projectName(entry) === operation.project || entry.aliases.includes(operation.project));
  }

  #restoreWorkspaceRecord(persisted) {
    const identity = { ownerId: persisted.ownerId, sessionNonce: persisted.sessionNonce };
    const remaining = persisted.expiresAt - Date.now();
    const internalLease = this.leases.tryAcquire('source-refresh', {
      ...identity,
      ttlMs: Math.max(1, remaining),
    });
    if (!internalLease) {
      this.logger.error('cannot restore persisted workspace lease capacity', {
        token: persisted.token,
        project: persisted.projectName,
      });
      return;
    }
    if (remaining <= 0) this.leases.sweep(Date.now() + 2);
    this.workspaceRecords.set(persisted.token, { ...persisted, internalLease });
  }

  #workspaceSnapshot(record) {
    const internal = this.leases.getLease(record.internalLease);
    const activeEditorUse = this.editorLifecycle.activeStatus?.();
    const editorUse = record.editorUseOperationId
      ? this.editorLifecycle.status(record.editorUseOperationId)
      : (activeEditorUse?.target?.projectKey === record.projectKey ? activeEditorUse : null);
    return {
      token: record.token,
      project: record.projectName,
      projectKey: record.projectKey,
      state: internal?.state ?? 'orphaned',
      acquiredAt: record.acquiredAt,
      heartbeatAt: record.heartbeatAt,
      expiresAt: record.expiresAt,
      editorUse,
    };
  }

  #publicLeases() {
    return this.leases.list().map((lease) => ({
      key: lease.key,
      state: lease.state,
      acquiredAt: lease.acquiredAt,
      heartbeatAt: lease.heartbeatAt,
      expiresAt: lease.expiresAt,
      orphanedAt: lease.orphanedAt,
    }));
  }

  #workspaceDurabilityFailure(error, workspace) {
    this.draining = true;
    this.logger.error('workspace lease durability is uncertain; broker forced to drain', {
      code: error.code,
      message: error.message,
      project: workspace.project,
    });
    return textResult(
      `${error.message}. The live source-refresh fence remains held and the broker is draining. ` +
        'Restart only after inspecting the workspace lease file.',
      true,
      { code: error.code ?? 'WORKSPACE_STORE_DURABILITY_UNCERTAIN', workspace, draining: true },
    );
  }

  #ownedWorkspaceRecord(token, connection) {
    const record = this.workspaceRecords.get(token);
    if (!record) throw new Error(`Unknown workspace lease "${token}".`);
    if (record.ownerId !== connection.id || record.sessionNonce !== connection.sessionNonce) {
      const error = new Error('Workspace lease owner/session does not match.');
      error.code = 'LEASE_IDENTITY_MISMATCH';
      throw error;
    }
    return record;
  }

  #activeWorkspaceRecord(connection, projectKey) {
    const attached = connection.workspaceLeases.get(projectKey);
    if (!attached) return null;
    const record = this.workspaceRecords.get(attached.token);
    if (!record) {
      connection.workspaceLeases.delete(projectKey);
      return null;
    }
    if (record.ownerId !== connection.id || record.sessionNonce !== connection.sessionNonce) {
      connection.workspaceLeases.delete(projectKey);
      const error = new Error('Workspace lease owner/session does not match.');
      error.code = 'LEASE_IDENTITY_MISMATCH';
      throw error;
    }
    const internal = this.leases.getLease(record.internalLease);
    if (!internal || internal.state !== 'active') {
      const error = new Error(
        `Workspace lease ${record.token} is ${internal?.state ?? 'missing'}; ` +
          'heartbeat the exact adapter session or explicitly resolve the fence before Unity mutations.',
      );
      error.code = 'WORKSPACE_LEASE_NOT_ACTIVE';
      throw error;
    }
    return record;
  }

  #asyncResourceKeys(spec, projectKey) {
    const projectHasWorkspaceLease = [...this.workspaceRecords.values()]
      .some((record) => record.projectKey === projectKey);
    return [
      ...(projectHasWorkspaceLease ? [] : ['source-refresh']),
      'heavy',
      ...(spec.exclusive ? ['exclusive-editor'] : []),
    ];
  }

  #restoreAsyncTracker(journalOperation) {
    const project = this.#projectForJournalOperation(journalOperation);
    const spec = asyncSpecFor(
      journalOperation.method,
      journalOperation.method === 'run_tests' ? { async_tests: true } : {},
    );
    if (!project || !spec) {
      this.#addRecoveryFault(
        journalOperation,
        !project ? 'ASYNC_PROJECT_NOT_CONFIGURED' : 'ASYNC_TOOL_NOT_TRACKABLE',
        project,
      );
      return;
    }
    if (journalOperation.statusTool !== spec.statusTool) {
      this.#addRecoveryFault(journalOperation, 'ASYNC_STATUS_TOOL_MISMATCH', project, {
        persistedStatusTool: journalOperation.statusTool,
        expectedStatusTool: spec.statusTool,
      });
      return;
    }
    if (spec.triggerTool === 'build' && !journalOperation.correlation?.buildId) {
      this.#addRecoveryFault(journalOperation, 'ASYNC_CORRELATION_MISSING', project);
      return;
    }
    const identity = { ownerId: journalOperation.operationId, sessionNonce: `recovered:${this.brokerId}` };
    const leases = [];
    for (const key of this.#asyncResourceKeys(spec, project.key)) {
      const lease = this.leases.tryAcquire(key, { ...identity, ttlMs: 10 * 60_000 });
      if (!lease) {
        for (const acquired of leases.reverse()) this.leases.release(acquired, identity);
        this.#addRecoveryFault(journalOperation, 'ASYNC_LEASE_RESTORE_FAILED', project, { resource: key });
        return;
      }
      leases.push(lease);
    }
    if (spec.triggerTool === 'recompile') {
      this.recompileListChangedGenerations.set(project.key, {
        operationId: journalOperation.operationId,
        announced: false,
        rediscovered: false,
        recovered: true,
      });
      this.toolInvalidationAnnouncements.delete(project.key);
      this.toolReannounceEpochs.delete(project.key);
    }
    this.#retainAsyncTracker({
      project,
      operation: {
        operationId: journalOperation.operationId,
        toolName: journalOperation.method,
        projectKey: project.key,
      },
      spec,
      correlation: journalOperation.correlation ?? null,
      leases,
      identity,
      recovered: true,
      // A broker restart cannot prove that the original trigger response was
      // delivered to its adapter. Track to terminal, then fence instead of
      // declaring success and permitting a blind replay.
      deliveryUncertain: true,
    });
  }

  #retainAsyncTracker({
    project,
    operation,
    spec,
    correlation = null,
    leases,
    identity,
    recovered = false,
    deliveryUncertain = false,
  }) {
    const prior = this.asyncByProject.get(project.key);
    if (prior && prior.operationId !== operation.operationId) {
      for (const lease of leases.reverse()) this.leases.release(lease, identity);
      this.#addRecoveryFault(
        this.journal.get(operation.operationId) ?? {
          operationId: operation.operationId,
          state: OPERATION_STATES.RUNNING,
          method: operation.toolName,
          project: this.projectName(project),
        },
        'ASYNC_PROJECT_ALREADY_TRACKED',
        project,
      );
      return;
    }
    const tracker = {
      project,
      operationId: operation.operationId,
      triggerTool: operation.toolName,
      spec,
      correlation,
      correlationFault: false,
      leases,
      identity,
      recovered,
      deliveryUncertain,
      terminalObserved: false,
      recompileListChangedEpochAtDispatch: operation.recompileListChangedEpochAtDispatch
        ?? this.#childToolListChangedEpoch(project.key),
      recompileTerminalEvaluated: false,
      completionPromise: null,
      timer: null,
      pollInFlight: false,
    };
    this.asyncByProject.set(project.key, tracker);
    this.#scheduleAsyncPoll(tracker, recovered ? 250 : 1_000);
  }

  #scheduleAsyncPoll(tracker, delayMs) {
    if (this.shuttingDown || this.asyncByProject.get(tracker.project.key) !== tracker) return;
    if (tracker.timer) clearTimeout(tracker.timer);
    tracker.timer = setTimeout(() => this.#pollAsyncTracker(tracker).catch((error) => {
      this.logger.warn('background operation poll failed', {
        operationId: tracker.operationId,
        statusTool: tracker.spec.statusTool,
        message: error.message,
      });
      this.#scheduleAsyncPoll(tracker, 1_000);
    }), delayMs);
    tracker.timer.unref();
  }

  async #pollAsyncTracker(tracker) {
    if (this.shuttingDown || tracker.pollInFlight || this.asyncByProject.get(tracker.project.key) !== tracker) return;
    tracker.pollInFlight = true;
    tracker.timer = null;
    try {
      for (const lease of tracker.leases) {
        this.leases.heartbeat(lease, { ...tracker.identity, ttlMs: 10 * 60_000 });
      }
      const response = await this.schedulerFor(tracker.project).enqueue({
        clientId: 'broker-async-poller',
        operationId: `async-poll:${randomUUID()}`,
        classification: this.recovery.classify(tracker.spec.statusTool),
        run: ({ deadlineAt }) => {
          const remainingMs = Math.max(1, deadlineAt - Date.now());
          return this.childFor(tracker.project).request(
            'tools/call',
            { name: tracker.spec.statusTool, arguments: {} },
            Math.min(remainingMs, this.config.toolTimeoutSec * 1000),
            {
              clientInfo: { name: 'unity-mcp-broker-async-poller', version: SERVER_VERSION },
              deadlineAt,
              startupTimeoutMs: Math.min(this.config.startupTimeoutSec * 1000, remainingMs),
            },
          );
        },
      });
      if (responseIsTerminal(tracker.spec, response)) {
        if (!responseMatchesAsyncCorrelation(tracker.correlation, response)) {
          tracker.correlationFault = true;
          this.#addRecoveryFault(
            this.journal.get(tracker.operationId),
            'ASYNC_CORRELATION_MISMATCH',
            tracker.project,
            { expected: tracker.correlation },
          );
          return;
        }
        await this.#completeAsyncTracker(tracker, response);
        return;
      }
      if (response.transportFailure) {
        await this.children.get(tracker.project.key)?.stop('async-poll-retry');
      }
    } finally {
      tracker.pollInFlight = false;
    }
    if (!tracker.correlationFault) this.#scheduleAsyncPoll(tracker, 1_000);
  }

  async #observeAsyncResponse(project, toolName, response) {
    const tracker = this.asyncByProject.get(project.key);
    if (!tracker) return;
    if (toolName !== tracker.spec.statusTool && !tracker.spec.allowedMutations.includes(toolName)) return;
    if (responseIsTerminal(tracker.spec, response)) {
      if (!responseMatchesAsyncCorrelation(tracker.correlation, response)) {
        tracker.correlationFault = true;
        this.#addRecoveryFault(
          this.journal.get(tracker.operationId),
          'ASYNC_CORRELATION_MISMATCH',
          tracker.project,
          { expected: tracker.correlation },
        );
        return;
      }
      await this.#completeAsyncTracker(tracker, response);
    }
  }

  async #completeAsyncTracker(tracker, terminalResponse = null) {
    if (this.asyncByProject.get(tracker.project.key) !== tracker) return;
    if (terminalResponse && !tracker.recompileTerminalEvaluated) {
      tracker.recompileTerminalEvaluated = true;
      if (tracker.triggerTool === 'recompile') {
        this.#announceSuccessfulRecompile(
          tracker.project,
          terminalResponse,
          tracker.recompileListChangedEpochAtDispatch,
          tracker.operationId,
        );
      }
    }
    tracker.terminalObserved = true;
    const pending = this.pendingByOperation.get(tracker.operationId);
    // A different Codex/Claude adapter may observe terminal status before the
    // trigger adapter's stdout callback ACK reaches the broker. Keep the
    // tracker and all leases until delivery is conclusively ACK or LOST.
    if (pending?.deliveryAckRequired && pending.deliveryDecision == null) return;
    if (tracker.completionPromise) return tracker.completionPromise;

    const completion = (async () => {
      if (this.journal.get(tracker.operationId)?.state === OPERATION_STATES.RUNNING) {
        if (tracker.deliveryUncertain) {
          await this.journal.markUnknownOutcome(tracker.operationId);
          this.#addUnknownFence(tracker.project.key, tracker.operationId);
        } else {
          await this.journal.markCompleted(tracker.operationId);
        }
      }
      const currentPending = this.pendingByOperation.get(tracker.operationId);
      if (currentPending) {
        this.#clearDeliveryTimer(currentPending);
        currentPending.state = tracker.deliveryUncertain ? 'UNKNOWN_OUTCOME' : 'COMPLETED';
      }
      this.recoveryFaults.delete(tracker.operationId);
      tracker.correlationFault = false;
      this.#releaseAsyncResources(tracker);
      this.pendingByOperation.delete(tracker.operationId);
    })();
    tracker.completionPromise = completion;
    void completion.catch((error) => {
      this.draining = true;
      this.logger.error('terminal async operation could not be finalized durably; broker drained', {
        operationId: tracker.operationId,
        message: error.message,
      });
    });
    return completion;
  }

  #releaseAsyncResources(tracker) {
    if (tracker.timer) clearTimeout(tracker.timer);
    tracker.timer = null;
    if (this.asyncByProject.get(tracker.project.key) === tracker) this.asyncByProject.delete(tracker.project.key);
    for (const lease of [...tracker.leases].reverse()) {
      try { this.leases.release(lease, tracker.identity); } catch { /* explicit reconciliation stays fail-closed */ }
    }
    tracker.leases.length = 0;
  }

  async #processAudit({ force = false } = {}) {
    if (!force && this.auditCache && Date.now() - this.auditCache.checkedAt < 2_000) {
      return this.auditCache.value;
    }
    if (!this.auditInFlight) return this.#startProcessAudit();

    // Ordinary status calls may share the current bounded snapshot. A forced
    // admission/dispatch check must be fresher than its own request, though:
    // an unmanaged process can appear after the current `ps` took its snapshot.
    // Queue one follow-up per in-flight generation, so forced callers coalesce
    // without ever running two process-table children concurrently.
    if (!force) return this.auditInFlight.promise;
    const generation = this.auditInFlight.generation;
    const existingFollowUp = this.auditFollowUps.get(generation);
    if (existingFollowUp) return existingFollowUp;
    const followUp = this.auditInFlight.promise.then(() => this.#startProcessAudit());
    this.auditFollowUps.set(generation, followUp);
    const forget = () => {
      if (this.auditFollowUps.get(generation) === followUp) this.auditFollowUps.delete(generation);
    };
    void followUp.then(forget, forget);
    return followUp;
  }

  #startProcessAudit() {
    if (this.auditInFlight) return this.auditInFlight.promise;
    const generation = ++this.auditGeneration;
    const auditPromise = (async () => {
      let value;
      try {
        const childPids = [...this.children.values()]
          .map((child) => child.snapshot())
          .filter((snapshot) => snapshot.alive && Number.isSafeInteger(snapshot.pid))
          .map((snapshot) => snapshot.pid);
        value = await this.processAuditor({
          brokerPid: process.pid,
          // An exited ChildProcess retains its old PID in Node. Never allow
          // that stale value to exempt a PID-reused direct `unity mcp` process.
          childPids,
          adapterPids: [...this.connections.values()]
            .map((connection) => connection.adapterPid)
            .filter(Number.isSafeInteger),
          configuredProjectPaths: this.config.projects.map((project) => project.path),
          maxConcurrentEditors: this.config.license.maxConcurrentEditors,
        });
      } catch (error) {
        value = Object.freeze({
          ok: false,
          findings: Object.freeze([{
            severity: 'error',
            kind: 'process_audit_failed',
            message: error?.message ?? String(error),
          }]),
          editors: Object.freeze([]),
        });
      }
      this.auditCache = { checkedAt: Date.now(), value };
      return value;
    })();
    const entry = { generation, promise: null };
    let trackedPromise;
    trackedPromise = auditPromise.finally(() => {
      if (this.auditInFlight === entry) this.auditInFlight = null;
    });
    entry.promise = trackedPromise;
    this.auditInFlight = entry;
    return trackedPromise;
  }

  async #systemSafetyViolation(project, classification, {
    force = false,
    requireExactActiveEditor = false,
  } = {}) {
    if (this.config.broker.processAuditEnforcement === 'report-only' && !requireExactActiveEditor) {
      return null;
    }
    const audit = await this.#processAudit({ force });
    const findings = (audit.findings ?? []).filter((finding) => {
      if (this.config.broker.processAuditEnforcement === 'report-only') return false;
      if (finding.severity !== 'error') return false;
      if (finding.kind === 'process_audit_failed') return true;
      if (
        finding.kind === 'duplicate_broker'
        || finding.kind === 'editor_seat_limit_exceeded'
        || finding.kind === 'editor_project_unknown'
        || finding.kind === 'unconfigured_editor'
      ) return true;
      if (finding.kind === 'duplicate_project_editor') return finding.projectPath === project.path;
      if (finding.kind === 'direct_unmanaged_unity_mcp') {
        return classification.mutation || finding.projectPath == null || finding.projectPath === project.path;
      }
      if (finding.kind === 'legacy_or_unattached_adapter') return classification.mutation;
      return false;
    });
    if (findings.length > 0) {
      return textResult(
        'Unity dispatch is blocked because unmanaged or conflicting local processes would bypass broker safety.',
        true,
        { code: 'SYSTEM_CONCURRENCY_UNSAFE', findings },
      );
    }
    if (requireExactActiveEditor && this.config.license.mode === 'single-seat') {
      if (audit?.ok !== true || !Array.isArray(audit.editors)) {
        return textResult(
          'Unity Editor process identity is not clean at mutation dispatch.',
          true,
          { code: 'EDITOR_PROCESS_AUDIT_UNSAFE', findings: audit?.findings ?? [] },
        );
      }
      const exact = audit.editors.find((editor) => editor.projectPath === project.path);
      if (!exact || audit.editors.length !== 1) {
        return textResult(
          `The exact single-seat Unity Editor for "${project.path}" is no longer active.`,
          true,
          {
            code: 'PROJECT_EDITOR_INACTIVE',
            targetProject: this.projectName(project),
            targetProjectPath: project.path,
            activeEditor: audit.editors.length === 1 ? audit.editors[0] : null,
          },
        );
      }
    }
    return null;
  }

  async #dispatchSafetyViolation(project, operation) {
    // Admission checks are advisory until the operation reaches the head of
    // its queue. Re-audit immediately before the durable DISPATCHING record so
    // a direct MCP/editor started while waiting cannot slip through the gate.
    const unsafe = await this.#systemSafetyViolation(
      project,
      operation.classification,
      { force: true, requireExactActiveEditor: true },
    );
    if (unsafe) return unsafe;

    const recoveryBlocks = [...this.recoveryFaults.values()].filter((fault) =>
      fault.projectKey == null || fault.projectKey === project.key);
    if (recoveryBlocks.length > 0) {
      return textResult(
        'Mutation dispatch was fenced because broker recovery state changed while the request was queued.',
        true,
        { code: 'PROJECT_RECOVERY_FENCE', faults: recoveryBlocks },
      );
    }

    const unresolved = this.unknownByProject.get(project.key);
    if (unresolved?.size) {
      return textResult(
        `Project "${this.projectName(project)}" became mutation-fenced while the request was queued.`,
        true,
        { code: 'PROJECT_UNKNOWN_OUTCOME_FENCE', operationIds: [...unresolved] },
      );
    }

    const deliveryPending = this.#deliveryPendingForProject(project.key)
      .filter((pending) => pending.operationId !== operation.operationId);
    if (deliveryPending.length > 0) {
      return textResult(
        `Project "${this.projectName(project)}" is still waiting for response acknowledgement ` +
          `for operation(s): ${deliveryPending.map((entry) => entry.operationId).join(', ')}.`,
        true,
        {
          code: 'PROJECT_DELIVERY_ACK_FENCE',
          operationIds: deliveryPending.map((entry) => entry.operationId),
        },
      );
    }

    const activeAsync = this.asyncByProject.get(project.key);
    if (activeAsync && !activeAsync.spec.allowedMutations.includes(operation.toolName)) {
      return textResult(
        `Project "${this.projectName(project)}" started background ${activeAsync.triggerTool} ` +
          `operation ${activeAsync.operationId} while the request was queued.`,
        true,
        {
          code: 'PROJECT_ASYNC_OPERATION_FENCE',
          operationId: activeAsync.operationId,
          statusTool: activeAsync.spec.statusTool,
        },
      );
    }
    return null;
  }

  async #sweepIdleChildren() {
    if (this.shuttingDown) return;
    const idleMs = this.config.broker.childIdleMin * 60_000;
    const now = Date.now();
    for (const project of this.config.projects) {
      const child = this.children.get(project.key);
      if (!child?.alive || child.lastUsedAt == null || now - child.lastUsedAt < idleMs) continue;
      const scheduler = this.schedulerFor(project);
      if (scheduler.snapshot().pending !== 0) continue;
      void scheduler.enqueue({
        clientId: 'broker-idle-sweeper',
        operationId: `idle-stop:${randomUUID()}`,
        classification: this.recovery.classify('editor_status'),
        run: async () => {
          if (Date.now() - (child.lastUsedAt ?? Date.now()) >= idleMs) await child.stop('idle');
        },
      }).catch(() => {});
    }
  }
}

export { PROTOCOL_VERSION, SERVER_VERSION, textResult };
