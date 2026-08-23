import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

export const OPERATION_STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  QUEUED: 'QUEUED',
  DISPATCHING: 'DISPATCHING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  CANCELLED: 'CANCELLED',
  RESOLVED: 'RESOLVED',
});

export const OPERATION_STATE = OPERATION_STATES;

// v2 adds durable RUNNING/RESOLVED records. Read v1 for an in-place upgrade,
// but every new append is v2 so an older release cannot silently misread the
// expanded state machine during rollback.
const FORMAT_VERSION = 2;
const READABLE_FORMAT_VERSIONS = new Set([1, FORMAT_VERSION]);
const SHA256 = /^[a-f0-9]{64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_RECORD_KEYS = new Set(['payload', 'args', 'arguments', 'params', 'result']);
const ALLOWED_TRANSITIONS = new Map([
  [OPERATION_STATES.RECEIVED, new Set([OPERATION_STATES.QUEUED, OPERATION_STATES.CANCELLED])],
  [OPERATION_STATES.QUEUED, new Set([OPERATION_STATES.DISPATCHING, OPERATION_STATES.CANCELLED])],
  [
    OPERATION_STATES.DISPATCHING,
    new Set([
      OPERATION_STATES.COMPLETED,
      OPERATION_STATES.UNKNOWN_OUTCOME,
      OPERATION_STATES.CANCELLED,
      OPERATION_STATES.RUNNING,
    ]),
  ],
  [OPERATION_STATES.COMPLETED, new Set()],
  [OPERATION_STATES.RUNNING, new Set([
    OPERATION_STATES.COMPLETED,
    OPERATION_STATES.UNKNOWN_OUTCOME,
    OPERATION_STATES.RESOLVED,
  ])],
  [OPERATION_STATES.UNKNOWN_OUTCOME, new Set([OPERATION_STATES.RESOLVED])],
  [OPERATION_STATES.CANCELLED, new Set()],
  [OPERATION_STATES.RESOLVED, new Set()],
]);
const RESOLUTIONS = new Set(['confirmed_completed', 'safe_to_retry', 'abandoned']);

export class OperationJournalError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'OperationJournalError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function assertSafeLabel(value, field, { optional = false } = {}) {
  if (optional && value == null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OperationJournalError(
      'JOURNAL_INVALID_INPUT',
      `${field} must be a non-empty string without control characters`,
      { field },
    );
  }
  return value;
}

function normalizeReasonCode(value, { optional = true } = {}) {
  if (value == null && optional) return undefined;
  if (typeof value !== 'string' || !REASON_CODE.test(value)) {
    throw new OperationJournalError(
      'JOURNAL_INVALID_INPUT',
      'reasonCode must be an uppercase machine-readable identifier',
      { field: 'reasonCode' },
    );
  }
  return value;
}

function canonicalJson(value, stack = new Set(), inArray = false) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('BigInt values are not JSON serializable');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? 'null' : undefined;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError('Binary payloads must be passed directly, not nested inside an object');
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported payload value');
  if (stack.has(value)) throw new TypeError('Circular payload is not JSON serializable');

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, stack, true) ?? 'null').join(',')}]`;
    }
    const pairs = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalJson(value[key], stack, false);
      if (encoded !== undefined) pairs.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${pairs.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

/** Compute a deterministic SHA-256 without retaining the raw operation args. */
export function sha256Payload(payload) {
  let bytes;
  if (Buffer.isBuffer(payload)) {
    bytes = payload;
  } else if (payload instanceof ArrayBuffer) {
    bytes = Buffer.from(payload);
  } else if (ArrayBuffer.isView(payload)) {
    bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  } else if (typeof payload === 'string') {
    bytes = Buffer.from(payload, 'utf8');
  } else {
    const canonical = canonicalJson(payload);
    if (canonical === undefined) throw new TypeError('Payload is not JSON serializable');
    bytes = Buffer.from(canonical, 'utf8');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function cloneOperation(operation) {
  return operation ? { ...operation } : null;
}

function normalizeCorrelation(value, { optional = true } = {}) {
  if (value == null && optional) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationJournalError('JOURNAL_INVALID_INPUT', 'correlation must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 8) {
    throw new OperationJournalError('JOURNAL_INVALID_INPUT', 'correlation must contain 1 to 8 fields');
  }
  return Object.freeze(Object.fromEntries(entries.map(([key, item]) => [
    assertSafeLabel(key, 'correlation key'),
    assertSafeLabel(item, `correlation.${key}`),
  ])));
}

function assertNoRawPayload(record, lineNumber) {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_RECORD_KEYS.has(key.toLowerCase())) {
      throw new OperationJournalError(
        'JOURNAL_UNSAFE_RECORD',
        'Operation journal contains a forbidden raw payload field',
        { lineNumber, field: key },
      );
    }
  }
}

function replayJournal(text) {
  const operations = new Map();
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  const completeLineCount = endsWithNewline ? lines.length - 1 : Math.max(0, lines.length - 1);

  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new OperationJournalError(
        'JOURNAL_CORRUPT',
        'Operation journal contains a malformed complete record',
        { lineNumber: index + 1 },
      );
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new OperationJournalError(
        'JOURNAL_CORRUPT',
        'Operation journal record must be an object',
        { lineNumber: index + 1 },
      );
    }
    assertNoRawPayload(record, index + 1);
    if (!READABLE_FORMAT_VERSIONS.has(record.version) || !ALLOWED_TRANSITIONS.has(record.state)) {
      throw new OperationJournalError(
        'JOURNAL_CORRUPT',
        'Operation journal record has an unsupported version or state',
        { lineNumber: index + 1 },
      );
    }

    const operationId = assertSafeLabel(record.operationId, 'operationId');
    const at = assertSafeLabel(record.at, 'at');
    const current = operations.get(operationId);

    if (record.state === OPERATION_STATES.RECEIVED) {
      if (current || !SHA256.test(record.payloadSha256 ?? '')) {
        throw new OperationJournalError(
          'JOURNAL_CORRUPT',
          'Invalid or duplicate RECEIVED operation journal record',
          { lineNumber: index + 1, operationId },
        );
      }
      operations.set(operationId, {
        operationId,
        project: assertSafeLabel(record.project, 'project', { optional: true }),
        projectKey: assertSafeLabel(record.projectKey, 'projectKey', { optional: true }),
        method: assertSafeLabel(record.method, 'method', { optional: true }),
        payloadSha256: record.payloadSha256,
        state: record.state,
        receivedAt: at,
        updatedAt: at,
      });
      continue;
    }

    if (!current || !ALLOWED_TRANSITIONS.get(current.state).has(record.state)) {
      throw new OperationJournalError(
        'JOURNAL_CORRUPT',
        'Operation journal contains an invalid state transition',
        { lineNumber: index + 1, operationId, from: current?.state ?? null, to: record.state },
      );
    }
    if (record.state === OPERATION_STATES.RESOLVED && !RESOLUTIONS.has(record.resolution)) {
      throw new OperationJournalError(
        'JOURNAL_CORRUPT',
        'Resolved operation has an invalid resolution',
        { lineNumber: index + 1, operationId },
      );
    }
    if (record.state === OPERATION_STATES.RUNNING) {
      assertSafeLabel(record.statusTool, 'statusTool');
    }
    const reasonCode = record.state === OPERATION_STATES.UNKNOWN_OUTCOME
      ? normalizeReasonCode(record.reasonCode)
      : undefined;
    const correlation = record.state === OPERATION_STATES.RUNNING
      ? normalizeCorrelation(record.correlation)
      : undefined;
    operations.set(operationId, {
      ...current,
      state: record.state,
      updatedAt: at,
      ...(record.recovery === 'restart' ? { recoveredAfterRestart: true } : {}),
      ...(record.state === OPERATION_STATES.RESOLVED ? { resolution: record.resolution } : {}),
      ...(record.state === OPERATION_STATES.RUNNING ? {
        statusTool: record.statusTool,
        ...(correlation === undefined ? {} : { correlation }),
      } : {}),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  }

  // A non-newline-terminated tail is ignored as a crash-truncated append,
  // even when it happens to contain valid JSON.
  return operations;
}

export class OperationJournal {
  #fileHandle;
  #operations;
  #clock;
  #tail = Promise.resolve();
  #fatalError = null;
  #acceptingWrites = true;
  #closed = false;

  constructor(filePath, fileHandle, operations, { clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.#fileHandle = fileHandle;
    this.#operations = operations;
    this.#clock = clock;
  }

  static async open(filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string');
    }
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

    let existing = Buffer.alloc(0);
    try {
      existing = await readFile(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const lastNewline = existing.lastIndexOf(0x0a);
    const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
    const completeBytes = existing.subarray(0, completeLength);
    const operations = replayJournal(completeBytes.toString('utf8'));
    const fileHandle = await open(filePath, 'a+', 0o600);
    try {
      await fileHandle.chmod(0o600);
      if (completeLength !== existing.length) {
        await fileHandle.truncate(completeLength);
        await fileHandle.sync();
      }
    } catch (error) {
      await fileHandle.close();
      throw error;
    }
    const journal = new OperationJournal(filePath, fileHandle, operations, options);

    for (const operation of [...operations.values()]) {
      if (operation.state === OPERATION_STATES.DISPATCHING) {
        await journal.#transition(operation.operationId, OPERATION_STATES.UNKNOWN_OUTCOME, {
          recovery: 'restart',
        });
      }
    }
    return journal;
  }

  get size() {
    return this.#operations.size;
  }

  get(operationId) {
    return cloneOperation(this.#operations.get(operationId));
  }

  list({ state } = {}) {
    if (state !== undefined && !ALLOWED_TRANSITIONS.has(state)) {
      throw new OperationJournalError('JOURNAL_INVALID_INPUT', `Unknown operation state: ${state}`);
    }
    return [...this.#operations.values()]
      .filter((operation) => state === undefined || operation.state === state)
      .map(cloneOperation);
  }

  recordReceived(input = {}) {
    const { operationId: suppliedOperationId, id, project, projectKey, method, toolName, payload, payloadSha256 } = input;
    const operationId = assertSafeLabel(suppliedOperationId ?? id, 'operationId');
    const normalizedProject = assertSafeLabel(project, 'project', { optional: true });
    const normalizedProjectKey = assertSafeLabel(projectKey, 'projectKey', { optional: true });
    const normalizedMethod = assertSafeLabel(method ?? toolName, 'method', { optional: true });
    const hasPayload = Object.prototype.hasOwnProperty.call(input, 'payload');

    let digest = payloadSha256;
    if (digest !== undefined && !SHA256.test(digest)) {
      throw new OperationJournalError(
        'JOURNAL_INVALID_INPUT',
        'payloadSha256 must be a lowercase SHA-256 hex digest',
      );
    }
    if (hasPayload) {
      const computed = sha256Payload(payload);
      if (digest !== undefined && digest !== computed) {
        throw new OperationJournalError('JOURNAL_INVALID_INPUT', 'payload and payloadSha256 do not match');
      }
      digest = computed;
    }
    if (digest === undefined) {
      throw new OperationJournalError(
        'JOURNAL_INVALID_INPUT',
        'recordReceived requires payload or payloadSha256',
      );
    }

    return this.#enqueue(async () => {
      if (this.#operations.has(operationId)) {
        throw new OperationJournalError(
          'JOURNAL_DUPLICATE_OPERATION',
          `Operation already exists: ${operationId}`,
          { operationId },
        );
      }
      const at = this.#now();
      const event = {
        version: FORMAT_VERSION,
        operationId,
        state: OPERATION_STATES.RECEIVED,
        at,
        ...(normalizedProject === undefined ? {} : { project: normalizedProject }),
        ...(normalizedProjectKey === undefined ? {} : { projectKey: normalizedProjectKey }),
        ...(normalizedMethod === undefined ? {} : { method: normalizedMethod }),
        payloadSha256: digest,
      };
      await this.#appendDurably(event);
      const operation = {
        operationId,
        project: normalizedProject,
        projectKey: normalizedProjectKey,
        method: normalizedMethod,
        payloadSha256: digest,
        state: OPERATION_STATES.RECEIVED,
        receivedAt: at,
        updatedAt: at,
      };
      this.#operations.set(operationId, operation);
      return cloneOperation(operation);
    });
  }

  transition(operationId, nextState) {
    return this.#transition(operationId, nextState);
  }

  markQueued(operationId) {
    return this.transition(operationId, OPERATION_STATES.QUEUED);
  }

  markDispatching(operationId) {
    return this.transition(operationId, OPERATION_STATES.DISPATCHING);
  }

  markCompleted(operationId) {
    return this.transition(operationId, OPERATION_STATES.COMPLETED);
  }

  markRunning(operationId, statusTool, correlation = undefined) {
    assertSafeLabel(statusTool, 'statusTool');
    const normalizedCorrelation = normalizeCorrelation(correlation);
    return this.#transition(operationId, OPERATION_STATES.RUNNING, {
      statusTool,
      ...(normalizedCorrelation === undefined ? {} : { correlation: normalizedCorrelation }),
    });
  }

  markUnknownOutcome(operationId, reasonCode = undefined) {
    const normalizedReasonCode = normalizeReasonCode(reasonCode);
    return this.#transition(operationId, OPERATION_STATES.UNKNOWN_OUTCOME, {
      ...(normalizedReasonCode === undefined ? {} : { reasonCode: normalizedReasonCode }),
    });
  }

  markCancelled(operationId) {
    return this.transition(operationId, OPERATION_STATES.CANCELLED);
  }

  markResolved(operationId, resolution) {
    if (!RESOLUTIONS.has(resolution)) {
      return Promise.reject(new OperationJournalError(
        'JOURNAL_INVALID_INPUT',
        `Unknown operation resolution: ${resolution}`,
      ));
    }
    return this.#transition(operationId, OPERATION_STATES.RESOLVED, { resolution });
  }

  async flush() {
    await this.#tail;
    if (this.#fatalError) throw this.#fatalError;
    if (this.#closed) return;
    try {
      await this.#fileHandle.sync();
    } catch (cause) {
      throw new OperationJournalError(
        'JOURNAL_IO',
        'Unable to flush the operation journal',
        undefined,
        { cause },
      );
    }
  }

  async close() {
    if (this.#closed) return;
    this.#acceptingWrites = false;
    await this.#tail;
    try {
      if (!this.#fatalError) await this.#fileHandle.sync();
    } finally {
      await this.#fileHandle.close();
      this.#closed = true;
    }
    if (this.#fatalError) throw this.#fatalError;
  }

  #transition(operationId, nextState, {
    recovery,
    resolution,
    statusTool,
    correlation,
    reasonCode,
  } = {}) {
    assertSafeLabel(operationId, 'operationId');
    if (!ALLOWED_TRANSITIONS.has(nextState)) {
      throw new OperationJournalError('JOURNAL_INVALID_INPUT', `Unknown operation state: ${nextState}`);
    }
    return this.#enqueue(async () => {
      const current = this.#operations.get(operationId);
      if (!current) {
        throw new OperationJournalError(
          'JOURNAL_UNKNOWN_OPERATION',
          `Unknown operation: ${operationId}`,
          { operationId },
        );
      }
      if (!ALLOWED_TRANSITIONS.get(current.state).has(nextState)) {
        throw new OperationJournalError(
          'JOURNAL_INVALID_TRANSITION',
          `Invalid operation transition ${current.state} -> ${nextState}`,
          { operationId, from: current.state, to: nextState },
        );
      }

      const at = this.#now();
      const event = {
        version: FORMAT_VERSION,
        operationId,
        state: nextState,
        at,
        ...(recovery === 'restart' ? { recovery: 'restart' } : {}),
        ...(nextState === OPERATION_STATES.RESOLVED ? { resolution } : {}),
        ...(nextState === OPERATION_STATES.RUNNING ? {
          statusTool,
          ...(correlation === undefined ? {} : { correlation }),
        } : {}),
        ...(nextState === OPERATION_STATES.UNKNOWN_OUTCOME && reasonCode !== undefined
          ? { reasonCode }
          : {}),
      };
      await this.#appendDurably(event);
      const updated = {
        ...current,
        state: nextState,
        updatedAt: at,
        ...(recovery === 'restart' ? { recoveredAfterRestart: true } : {}),
        ...(nextState === OPERATION_STATES.RESOLVED ? { resolution } : {}),
        ...(nextState === OPERATION_STATES.RUNNING ? {
          statusTool,
          ...(correlation === undefined ? {} : { correlation }),
        } : {}),
        ...(nextState === OPERATION_STATES.UNKNOWN_OUTCOME && reasonCode !== undefined
          ? { reasonCode }
          : {}),
      };
      this.#operations.set(operationId, updated);
      return cloneOperation(updated);
    });
  }

  #enqueue(work) {
    if (!this.#acceptingWrites || this.#closed) {
      return Promise.reject(new OperationJournalError('JOURNAL_CLOSED', 'Operation journal is closed'));
    }
    const result = this.#tail.then(async () => {
      if (this.#fatalError) throw this.#fatalError;
      return work();
    });
    this.#tail = result.then(
      () => undefined,
      (error) => {
        if (error?.code === 'JOURNAL_IO') this.#fatalError = error;
      },
    );
    return result;
  }

  #now() {
    const value = this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new OperationJournalError('JOURNAL_INVALID_CLOCK', 'Journal clock returned an invalid date');
    }
    return date.toISOString();
  }

  async #appendDurably(event) {
    const encoded = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    try {
      const { bytesWritten } = await this.#fileHandle.write(encoded, 0, encoded.length, null);
      if (bytesWritten !== encoded.length) {
        throw new Error(`short journal append: ${bytesWritten}/${encoded.length} bytes`);
      }
      await this.#fileHandle.sync();
    } catch (cause) {
      throw new OperationJournalError(
        'JOURNAL_IO',
        'Unable to durably append the operation journal',
        undefined,
        { cause },
      );
    }
  }
}
