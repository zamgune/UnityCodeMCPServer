const HEAVY_KINDS = new Set(['heavy', 'exclusive', 'tracked_async', 'unknown']);

export class SchedulerError extends Error {
  constructor(message, { code = 'SCHEDULER_ERROR', details } = {}) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be an integer >= 1`);
  }
  return value;
}

function isHeavyClassification(classification) {
  if (classification == null) return true;
  if (typeof classification === 'object' && typeof classification.heavy === 'boolean') {
    return classification.heavy;
  }
  const kind = typeof classification === 'string' ? classification : classification.kind;
  return HEAVY_KINDS.has(kind ?? 'unknown');
}

/**
 * Shared across all project schedulers. It enforces machine-wide pending and
 * heavy-operation limits while allowing light work on different projects to
 * overlap.
 */
export class SchedulerBudget {
  constructor({ maxPendingTotal = 512, maxHeavyInFlight = 1 } = {}) {
    this.maxPendingTotal = positiveInteger(maxPendingTotal, 'maxPendingTotal');
    this.maxHeavyInFlight = positiveInteger(maxHeavyInFlight, 'maxHeavyInFlight');
    this.pendingTotal = 0;
    this.activeHeavy = 0;
    this.heavyHolds = new Set();
    this.listeners = new Set();
    this.listenerCursor = 0;
  }

  reserveOutstanding() {
    if (this.pendingTotal >= this.maxPendingTotal) {
      throw new SchedulerError(
        `Broker queue is full (${this.pendingTotal}/${this.maxPendingTotal})`,
        { code: 'TOTAL_QUEUE_FULL' },
      );
    }
    this.pendingTotal += 1;
  }

  releaseOutstanding() {
    if (this.pendingTotal <= 0) {
      throw new SchedulerError('Scheduler budget underflow', { code: 'BUDGET_UNDERFLOW' });
    }
    this.pendingTotal -= 1;
  }

  tryStart({ heavy }) {
    if (!heavy) return true;
    if (this.activeHeavy + this.heavyHolds.size >= this.maxHeavyInFlight) return false;
    this.activeHeavy += 1;
    return true;
  }

  finish({ heavy }) {
    if (!heavy) return;
    if (this.activeHeavy <= 0) {
      throw new SchedulerError('Heavy scheduler budget underflow', {
        code: 'HEAVY_BUDGET_UNDERFLOW',
      });
    }
    this.activeHeavy -= 1;
    const listeners = [...this.listeners];
    if (listeners.length > 0) {
      // A Set's insertion order otherwise lets the first-created project win
      // every newly freed heavy slot. Rotate the first wake-up so a busy
      // project cannot starve later projects indefinitely.
      this.listenerCursor = (this.listenerCursor + 1) % listeners.length;
      for (let offset = 0; offset < listeners.length; offset += 1) {
        queueMicrotask(listeners[(this.listenerCursor + offset) % listeners.length]);
      }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  holdHeavy(operationId) {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new TypeError('operationId must be a non-empty string');
    }
    const sizeBefore = this.heavyHolds.size;
    this.heavyHolds.add(operationId);
    return this.heavyHolds.size !== sizeBefore;
  }

  releaseHeavyHold(operationId) {
    if (!this.heavyHolds.delete(operationId)) return false;
    const listeners = [...this.listeners];
    for (const listener of listeners) queueMicrotask(listener);
    return true;
  }

  hasHeavyHold(operationId) {
    return this.heavyHolds.has(operationId);
  }

  listHeavyHolds() {
    return [...this.heavyHolds].sort();
  }

  snapshot() {
    return Object.freeze({
      pendingTotal: this.pendingTotal,
      maxPendingTotal: this.maxPendingTotal,
      activeHeavy: this.activeHeavy + this.heavyHolds.size,
      runningHeavy: this.activeHeavy,
      heldHeavy: this.heavyHolds.size,
      maxHeavyInFlight: this.maxHeavyInFlight,
    });
  }
}

export class ProjectScheduler {
  constructor({
    projectKey,
    budget = new SchedulerBudget(),
    maxPendingPerClient = 32,
    maxPendingPerProject = 128,
    deadlineMs,
    deadlineSec = 300,
    now = Date.now,
    onStateChange,
  } = {}) {
    if (typeof projectKey !== 'string' || projectKey.length === 0) {
      throw new TypeError('projectKey must be a non-empty string');
    }
    if (!(budget instanceof SchedulerBudget)) {
      throw new TypeError('budget must be a SchedulerBudget');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    this.projectKey = projectKey;
    this.budget = budget;
    this.maxPendingPerClient = positiveInteger(maxPendingPerClient, 'maxPendingPerClient');
    this.maxPendingPerProject = positiveInteger(maxPendingPerProject, 'maxPendingPerProject');
    this.defaultDeadlineMs = deadlineMs ?? deadlineSec * 1000;
    if (!Number.isFinite(this.defaultDeadlineMs) || this.defaultDeadlineMs <= 0) {
      throw new TypeError('deadlineMs/deadlineSec must resolve to a positive finite duration');
    }
    this.now = now;
    this.onStateChange = onStateChange;

    this.clientQueues = new Map();
    this.activeClients = [];
    this.clientOutstanding = new Map();
    this.queuedById = new Map();
    this.projectOutstanding = 0;
    this.activeItem = null;
    this.lastClientId = null;
    this.closed = false;
    this.drainScheduled = false;
    this.idleWaiters = new Set();
    this.unsubscribeBudget = this.budget.subscribe(() => this.#scheduleDrain());
  }

  enqueue({
    clientId,
    operationId,
    classification,
    run,
    deadlineAt,
    deadlineMs = this.defaultDeadlineMs,
    signal,
  }) {
    try {
      if (this.closed) {
        throw new SchedulerError(`Scheduler for ${this.projectKey} is closed`, {
          code: 'SCHEDULER_CLOSED',
        });
      }
      if (typeof clientId !== 'string' || clientId.length === 0) {
        throw new TypeError('clientId must be a non-empty string');
      }
      if (typeof operationId !== 'string' || operationId.length === 0) {
        throw new TypeError('operationId must be a non-empty string');
      }
      if (typeof run !== 'function') throw new TypeError('run must be a function');
      if (this.queuedById.has(operationId) || this.activeItem?.operationId === operationId) {
        throw new SchedulerError(`Duplicate operationId: ${operationId}`, {
          code: 'DUPLICATE_OPERATION',
        });
      }
      if (signal?.aborted) {
        throw new SchedulerError(`Operation ${operationId} was cancelled before queueing`, {
          code: 'CANCELLED',
        });
      }

      const clientCount = this.clientOutstanding.get(clientId) ?? 0;
      if (clientCount >= this.maxPendingPerClient) {
        throw new SchedulerError(
          `Client ${clientId} queue is full (${clientCount}/${this.maxPendingPerClient})`,
          { code: 'CLIENT_QUEUE_FULL' },
        );
      }
      if (this.projectOutstanding >= this.maxPendingPerProject) {
        throw new SchedulerError(
          `Project ${this.projectKey} queue is full ` +
            `(${this.projectOutstanding}/${this.maxPendingPerProject})`,
          { code: 'PROJECT_QUEUE_FULL' },
        );
      }
      this.budget.reserveOutstanding();

      const absoluteDeadline = deadlineAt ?? this.now() + deadlineMs;
      if (!Number.isFinite(absoluteDeadline)) {
        this.budget.releaseOutstanding();
        throw new TypeError('deadlineAt must be finite');
      }

      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const item = {
        clientId,
        operationId,
        classification,
        heavy: isHeavyClassification(classification),
        run,
        deadlineAt: absoluteDeadline,
        signal,
        resolve: resolvePromise,
        reject: rejectPromise,
        state: 'queued',
        released: false,
        abortListener: null,
      };

      this.projectOutstanding += 1;
      this.clientOutstanding.set(clientId, clientCount + 1);
      this.queuedById.set(operationId, item);

      let queue = this.clientQueues.get(clientId);
      if (!queue) {
        queue = [];
        this.clientQueues.set(clientId, queue);
        this.activeClients.push(clientId);
      }
      queue.push(item);

      if (signal) {
        item.abortListener = () => this.cancel(operationId, 'AbortSignal');
        signal.addEventListener('abort', item.abortListener, { once: true });
      }

      this.#notifyState();
      this.#scheduleDrain();
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Cancel only an operation that has not been dispatched. */
  cancel(operationId, reason = 'cancelled by client') {
    const item = this.queuedById.get(operationId);
    if (!item || item.state !== 'queued') return false;
    item.state = 'cancelled';
    this.queuedById.delete(operationId);
    this.#detachAbort(item);
    this.#releaseOutstanding(item);
    item.reject(
      new SchedulerError(`Operation ${operationId} cancelled: ${reason}`, {
        code: 'CANCELLED',
      }),
    );
    this.#notifyState();
    this.#scheduleDrain();
    return true;
  }

  close(reason = 'scheduler closed') {
    if (this.closed) return;
    this.closed = true;
    for (const operationId of [...this.queuedById.keys()]) this.cancel(operationId, reason);
    this.unsubscribeBudget();
    this.#notifyState();
    this.#resolveIdleIfNeeded();
  }

  async waitForIdle() {
    if (this.projectOutstanding === 0) return;
    await new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  snapshot() {
    return Object.freeze({
      projectKey: this.projectKey,
      closed: this.closed,
      activeOperationId: this.activeItem?.operationId ?? null,
      activeClientId: this.activeItem?.clientId ?? null,
      pending: this.projectOutstanding,
      queued: this.queuedById.size,
      clients: Object.freeze(Object.fromEntries(this.clientOutstanding)),
      budget: this.budget.snapshot(),
    });
  }

  #scheduleDrain() {
    if (this.drainScheduled || this.closed || this.activeItem) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.#drain();
    });
  }

  #drain() {
    if (this.closed || this.activeItem) return;
    const item = this.#takeNextEligible();
    if (!item) {
      this.#resolveIdleIfNeeded();
      return;
    }

    item.state = 'active';
    this.queuedById.delete(item.operationId);
    this.#detachAbort(item);
    this.activeItem = item;
    this.lastClientId = item.clientId;
    this.#notifyState();

    const context = Object.freeze({
      projectKey: this.projectKey,
      clientId: item.clientId,
      operationId: item.operationId,
      classification: item.classification,
      deadlineAt: item.deadlineAt,
      remainingMs: Math.max(0, item.deadlineAt - this.now()),
    });

    Promise.resolve()
      .then(() => item.run(context))
      .then(
        (value) => {
          item.state = 'completed';
          item.resolve(value);
        },
        (error) => {
          item.state = 'failed';
          item.reject(error);
        },
      )
      .finally(() => {
        this.activeItem = null;
        this.budget.finish({ heavy: item.heavy });
        this.#releaseOutstanding(item);
        this.#notifyState();
        this.#resolveIdleIfNeeded();
        // Releasing a global heavy slot wakes every project scheduler in a
        // rotated order. Scheduling this project directly as well would let
        // it reacquire before the rotated contender and starve other projects.
        if (!item.heavy) this.#scheduleDrain();
      });
  }

  #takeNextEligible() {
    this.#compactClientHeads();
    if (this.activeClients.length > 1 && this.activeClients[0] === this.lastClientId) {
      this.activeClients.push(this.activeClients.shift());
    }

    const clientsToInspect = this.activeClients.length;
    for (let inspected = 0; inspected < clientsToInspect; inspected += 1) {
      const clientId = this.activeClients.shift();
      const queue = this.clientQueues.get(clientId);
      this.#dropDeadHeads(clientId, queue);
      if (!queue?.length) continue;

      const item = queue[0];
      if (!this.budget.tryStart({ heavy: item.heavy })) {
        this.activeClients.push(clientId);
        continue;
      }

      queue.shift();
      if (queue.length) this.activeClients.push(clientId);
      else this.clientQueues.delete(clientId);
      return item;
    }
    return null;
  }

  #compactClientHeads() {
    for (const clientId of [...this.activeClients]) {
      this.#dropDeadHeads(clientId, this.clientQueues.get(clientId));
    }
    this.activeClients = this.activeClients.filter((clientId, index, list) => {
      return this.clientQueues.get(clientId)?.length && list.indexOf(clientId) === index;
    });
  }

  #dropDeadHeads(clientId, queue) {
    while (queue?.length) {
      const item = queue[0];
      if (item.state === 'cancelled') {
        queue.shift();
        continue;
      }
      if (item.deadlineAt > this.now()) break;
      queue.shift();
      item.state = 'expired';
      this.queuedById.delete(item.operationId);
      this.#detachAbort(item);
      this.#releaseOutstanding(item);
      item.reject(
        new SchedulerError(`Operation ${item.operationId} expired before dispatch`, {
          code: 'DEADLINE_EXCEEDED',
        }),
      );
    }
    if (queue && queue.length === 0) this.clientQueues.delete(clientId);
  }

  #detachAbort(item) {
    if (item.signal && item.abortListener) {
      item.signal.removeEventListener('abort', item.abortListener);
      item.abortListener = null;
    }
  }

  #releaseOutstanding(item) {
    if (item.released) return;
    item.released = true;
    this.projectOutstanding -= 1;
    const clientCount = (this.clientOutstanding.get(item.clientId) ?? 1) - 1;
    if (clientCount <= 0) this.clientOutstanding.delete(item.clientId);
    else this.clientOutstanding.set(item.clientId, clientCount);
    this.budget.releaseOutstanding();
  }

  #notifyState() {
    if (typeof this.onStateChange === 'function') this.onStateChange(this.snapshot());
  }

  #resolveIdleIfNeeded() {
    if (this.projectOutstanding !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
