import { spawn } from 'node:child_process';
import { JsonRpcLineDecoder, encodeJsonRpcLine } from './mcp-framing.mjs';
import { MCP_PROTOCOL_VERSION } from './mcp-protocol.mjs';
import { NULL_LOGGER } from './logger.mjs';

const IMMEDIATE_STOP_REASONS = new Set([
  'adapter-disconnect',
  'async-poll-retry',
  'discovery-cancel',
  'discovery-retry',
  'initialize-failed',
  'protocol-mismatch',
  'protocol-retry',
  'startup-cancel',
  'tool-retry',
]);

export class UnityMcpChild {
  constructor({ project, unityBin, unityArgs = [], startupTimeoutMs = 60_000, toolTimeoutMs = 300_000, env = process.env, logger = NULL_LOGGER, beforeSpawn = async () => {}, onNotification = () => {}, onLifecycle = () => {} }) {
    this.project = project;
    this.unityBin = unityBin;
    this.unityArgs = unityArgs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.env = env;
    this.logger = logger.child({ projectId: project.id ?? project.key, project: project.name ?? project.aliases?.[0] });
    this.beforeSpawn = beforeSpawn;
    this.onNotification = onNotification;
    this.onLifecycle = onLifecycle;
    this.proc = null;
    this.decoder = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.startedAt = null;
    this.serverInfo = null;
    this.protocolVersion = null;
    this.state = 'OFFLINE';
    this.activeContext = null;
    this.lastUsedAt = null;
    this.processGeneration = 0;
    this.expectedExitProcesses = new WeakMap();
  }

  get alive() {
    return this.proc != null && this.proc.exitCode == null && !this.proc.killed;
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      alive: this.alive,
      ready: this.state === 'READY' || this.state === 'BUSY',
      startedAt: this.startedAt,
      serverInfo: this.serverInfo,
      protocolVersion: this.protocolVersion,
      pending: this.pending.size,
      lastUsedAt: this.lastUsedAt,
    };
  }

  async start(
    protocolVersion = MCP_PROTOCOL_VERSION,
    clientInfo = { name: 'unity-mcp-broker', version: '2.0.0' },
    context = {},
  ) {
    if (this.alive && (this.state === 'READY' || this.state === 'BUSY')) {
      if (this.protocolVersion !== protocolVersion) {
        throw new Error(
          `unity mcp child protocol ${this.protocolVersion} cannot serve requested ${protocolVersion}`,
        );
      }
      return this.serverInfo;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start(protocolVersion, clientInfo, context).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start(protocolVersion, clientInfo, context) {
    const callerDeadlineRemainingMs = Number.isFinite(context.deadlineAt)
      ? context.deadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
    if (callerDeadlineRemainingMs <= 0) {
      const error = new Error(`unity mcp startup deadline expired for ${this.project.name}`);
      error.code = 'DEADLINE_EXCEEDED';
      throw error;
    }
    const requestedStartupTimeoutMs = Number(context.startupTimeoutMs);
    const startupBudgetMs = Math.max(1, Math.min(
      this.startupTimeoutMs,
      Number.isFinite(requestedStartupTimeoutMs) && requestedStartupTimeoutMs > 0
        ? requestedStartupTimeoutMs
        : this.startupTimeoutMs,
      callerDeadlineRemainingMs,
    ));
    const startupDeadlineAt = Date.now() + startupBudgetMs;
    if (this.alive) await this.stop('restart');
    await this.beforeSpawn({
      project: this.project,
      deadlineAt: Math.min(
        startupDeadlineAt,
        Number.isFinite(context.deadlineAt) ? context.deadlineAt : Number.POSITIVE_INFINITY,
      ),
      context,
    });
    const startupTimeoutMs = startupDeadlineAt - Date.now();
    if (startupTimeoutMs <= 0) {
      const error = new Error(`unity mcp startup deadline expired during project access gate for ${this.project.name}`);
      error.code = 'DEADLINE_EXCEEDED';
      throw error;
    }
    this.state = 'STARTING';
    const projectPath = this.project.canonicalPath ?? this.project.path;
    const args = [...this.unityArgs, 'mcp', '--project-path', projectPath, ...(this.project.extraArgs ?? [])];
    // Command-line extensions can contain credentials. Keep only structural
    // metadata; never persist the raw child argv.
    this.logger.info('spawning unity mcp child', {
      unityBin: this.unityBin,
      projectPath,
      extraArgCount: this.unityArgs.length + (this.project.extraArgs?.length ?? 0),
      state: this.state,
    });
    const decoder = new JsonRpcLineDecoder();
    const proc = spawn(this.unityBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    const processGeneration = ++this.processGeneration;
    let lifecycleReported = false;
    const reportLifecycle = (kind, details = {}) => {
      if (lifecycleReported) return;
      lifecycleReported = true;
      this.onLifecycle({
        kind,
        expected: this.expectedExitProcesses.has(proc),
        expectedReason: this.expectedExitProcesses.get(proc) ?? null,
        processGeneration,
        pid: proc.pid ?? null,
        ...details,
      });
    };
    this.decoder = decoder;
    this.proc = proc;
    this.startedAt = new Date().toISOString();

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      try {
        for (const message of decoder.push(chunk)) this.#onMessage(message, proc);
      } catch (error) {
        this.logger.warn('invalid child framing', { message: error.message });
        if (this.proc === proc) this.state = 'FAILED';
        this.#failPending(`unity mcp emitted invalid JSON-RPC framing: ${error.message}`, proc);
        // A corrupt stream cannot be resynchronized safely. Quarantine this
        // child immediately instead of occupying the project queue until the
        // normal multi-minute tool timeout expires.
        try { proc.stdin.end(); } catch { /* already closed */ }
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      }
    });
    proc.stderr.setEncoding('utf8');
    // Unity/Hub stderr can contain opaque credentials. Record volume only.
    proc.stderr.on('data', (chunk) => this.logger.debug('unity mcp stderr received', {
      bytes: Buffer.byteLength(String(chunk)),
    }));
    proc.on('error', (error) => {
      this.logger.error('unity mcp spawn error', { message: error.message });
      if (this.proc === proc) this.state = 'FAILED';
      this.#failPending(`unity mcp spawn failed: ${error.message}`, proc);
      reportLifecycle('error', { message: error.message });
    });
    proc.on('exit', (code, signal) => {
      this.logger.warn('unity mcp child exited', { code, signal });
      if (this.proc === proc && this.state !== 'STOPPING') this.state = 'OFFLINE';
      this.#failPending(`unity mcp exited (code=${code} signal=${signal})`, proc);
      reportLifecycle('exit', { code, signal });
    });

    const initialized = await this.requestRaw('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo,
    }, startupTimeoutMs, { ...context, phase: 'initialize' });
    if (initialized.error) {
      this.state = 'FAILED';
      await this.stop('initialize-failed');
      const error = new Error(
        `initialize failed for ${this.project.name}: ${initialized.error.message ?? JSON.stringify(initialized.error)}`,
      );
      if (Number.isFinite(context.deadlineAt) && Date.now() >= context.deadlineAt) {
        error.code = 'DEADLINE_EXCEEDED';
      }
      throw error;
    }
    const negotiatedProtocolVersion = initialized.result?.protocolVersion;
    if (negotiatedProtocolVersion !== protocolVersion) {
      this.state = 'FAILED';
      await this.stop('protocol-mismatch');
      throw new Error(
        `unity mcp negotiated unsupported protocol ${String(negotiatedProtocolVersion)}; expected ${protocolVersion}`,
      );
    }
    this.serverInfo = initialized.result?.serverInfo ?? null;
    this.protocolVersion = negotiatedProtocolVersion;
    this.sendNotification('notifications/initialized', {});
    this.state = 'READY';
    if (this.proc !== proc || !this.alive) throw new Error(`unity mcp exited during startup for ${this.project.name}`);
    this.logger.info('unity mcp child ready', { pid: proc.pid, serverInfo: this.serverInfo });
    return initialized.result;
  }

  async request(method, params, timeoutMs = this.toolTimeoutMs, context = {}) {
    if (context.requireAlreadyStarted === true) {
      const ready = this.alive && (this.state === 'READY' || this.state === 'BUSY');
      const protocolMatches = context.protocolVersion == null
        || this.protocolVersion === context.protocolVersion;
      if (!ready || !protocolMatches) {
        return {
          transportFailure: true,
          dispatched: false,
          error: {
            code: -32070,
            message: `unity mcp process for "${this.project.name}" is not ready for audited dispatch.`,
          },
        };
      }
    } else {
      await this.start(context.protocolVersion, context.clientInfo, context);
    }
    if (context.isCancelled?.()) {
      return {
        transportFailure: true,
        dispatched: false,
        error: { code: -32800, message: `Request cancelled before ${method} dispatch.` },
      };
    }
    const deadlineRemainingMs = Number.isFinite(context.deadlineAt)
      ? context.deadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
    if (deadlineRemainingMs <= 0) {
      return {
        transportFailure: true,
        dispatched: false,
        error: { code: -32072, message: `Deadline expired before ${method} dispatch.` },
      };
    }
    this.lastUsedAt = Date.now();
    this.state = 'BUSY';
    this.activeContext = context;
    try {
      return await this.requestRaw(
        method,
        params,
        Math.max(1, Math.min(timeoutMs, deadlineRemainingMs)),
        context,
      );
    } finally {
      this.activeContext = null;
      if (this.alive) this.state = 'READY';
    }
  }

  requestRaw(method, params, timeoutMs, context = {}) {
    const id = `b${this.nextId++}`;
    const proc = this.proc;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#writeTo(proc, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'broker timeout' } });
        this.pending.delete(id);
        resolve({
          transportFailure: true,
          dispatched: true,
          error: { code: -32071, message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${method} on project "${this.project.name}".` },
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, method, context, dispatched: false, proc });
      if (!this.#writeTo(proc, message)) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          transportFailure: true,
          dispatched: false,
          error: { code: -32070, message: `unity mcp process for "${this.project.name}" is not running.` },
        });
      } else {
        const entry = this.pending.get(id);
        if (entry) entry.dispatched = true;
        // Publish the child request id only after the original frame has been
        // written. This guarantees a cancellation frame cannot overtake it.
        context.onChildRequestId?.(id);
      }
    });
  }

  sendNotification(method, params) {
    return this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  cancel(requestId, reason) {
    return this.sendNotification('notifications/cancelled', { requestId, ...(reason ? { reason } : {}) });
  }

  #write(message) {
    return this.#writeTo(this.proc, message);
  }

  #writeTo(proc, message) {
    if (!proc || proc.exitCode != null || proc.killed) return false;
    try {
      proc.stdin.write(encodeJsonRpcLine(message));
      return true;
    } catch (error) {
      this.logger.error('unity mcp stdin write failed', { message: error.message });
      return false;
    }
  }

  #onMessage(message, proc) {
    if (message.id != null && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      if (entry.proc !== proc) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve({ ...message, dispatched: entry.dispatched });
      return;
    }
    if (message.id == null) {
      if (this.proc === proc) this.onNotification(message, this.activeContext);
      return;
    }
    this.logger.debug('unmatched child response', { id: message.id });
  }

  #failPending(message, proc = this.proc) {
    for (const [id, entry] of this.pending) {
      if (entry.proc !== proc) continue;
      clearTimeout(entry.timer);
      entry.resolve({
        transportFailure: true,
        dispatched: entry.dispatched,
        error: { code: -32070, message },
      });
      this.pending.delete(id);
    }
  }

  async stop(reason = 'manual') {
    if (!this.alive) {
      this.state = 'OFFLINE';
      this.protocolVersion = null;
      return;
    }
    const proc = this.proc;
    this.state = 'STOPPING';
    this.expectedExitProcesses.set(proc, reason);
    try { proc.stdin.end(); } catch { /* ignored */ }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        clearTimeout(finishTimer);
        resolve();
      };
      const termTimer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { finish(); }
      }, IMMEDIATE_STOP_REASONS.has(reason) ? 0 : 1_000);
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignored */ }
      }, 3_000);
      const finishTimer = setTimeout(finish, 5_000);
      proc.once('exit', finish);
    });
    if (this.proc === proc) {
    this.state = 'OFFLINE';
    this.protocolVersion = null;
      this.proc = null;
    }
  }
}
