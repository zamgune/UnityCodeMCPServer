import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const DEFAULT_LEASE_TTL_MS = 30_000;

export const DEFAULT_LEASE_CAPACITIES = Object.freeze({
  'editor-seat': 1,
  'source-refresh': 1,
  heavy: 1,
  'player-connection': 1,
  'exclusive-editor': 1,
});

export class LeaseError extends Error {
  constructor(message, code = 'LEASE_ERROR', details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class LeaseIdentityError extends LeaseError {
  constructor(message = 'Lease owner or session does not match') {
    super(message, 'LEASE_IDENTITY_MISMATCH');
  }
}

export class LeaseNotFoundError extends LeaseError {
  constructor(token) {
    super(`Lease not found: ${token}`, 'LEASE_NOT_FOUND', { token });
  }
}

export class LeaseCancelledError extends LeaseError {
  constructor(requestId, reason = 'Lease request cancelled') {
    super(String(reason || 'Lease request cancelled'), 'LEASE_REQUEST_CANCELLED', { requestId });
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeIdentity({ ownerId, sessionNonce } = {}) {
  return {
    ownerId: nonEmptyString(ownerId, 'ownerId'),
    sessionNonce: nonEmptyString(sessionNonce, 'sessionNonce'),
  };
}

function normalizeCapacities(capacities) {
  if (capacities == null) return new Map();
  const entries = capacities instanceof Map ? capacities.entries() : Object.entries(capacities);
  const result = new Map();
  for (const [key, value] of entries) {
    result.set(nonEmptyString(key, 'capacity key'), positiveInteger(value, `capacity for ${key}`));
  }
  return result;
}

export function defaultLeaseCapacity(resourceKey) {
  const key = nonEmptyString(resourceKey, 'resourceKey');
  if (Object.hasOwn(DEFAULT_LEASE_CAPACITIES, key)) return DEFAULT_LEASE_CAPACITIES[key];
  if (key.startsWith('project:')) return 1;
  if (key.startsWith('device:')) return 1;
  if (key.startsWith('build-output:')) return 1;
  return undefined;
}

function leaseToken(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof input.token === 'string') return input.token;
  throw new TypeError('lease must be a token string or lease object');
}

function requestIdentifier(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof input.requestId === 'string') return input.requestId;
  throw new TypeError('request must be a request id string or request handle');
}

function leaseSnapshot(lease) {
  return Object.freeze({
    token: lease.token,
    requestId: lease.requestId,
    key: lease.key,
    ownerId: lease.ownerId,
    sessionNonce: lease.sessionNonce,
    state: lease.state,
    acquiredAt: lease.acquiredAt,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt,
    orphanedAt: lease.orphanedAt ?? null,
  });
}

function queuedSnapshot(request) {
  return Object.freeze({
    requestId: request.requestId,
    key: request.key,
    ownerId: request.ownerId,
    sessionNonce: request.sessionNonce,
    status: request.status,
    queuedAt: request.queuedAt,
    ttlMs: request.ttlMs,
  });
}

/**
 * In-memory, fail-closed lease broker.
 *
 * Expired leases become `orphaned` and continue consuming capacity. They are
 * never reassigned automatically: the exact owner/session can heartbeat or
 * release them, or an explicit administrative layer can decide what to do.
 */
export class LeaseManager extends EventEmitter {
  constructor({
    capacities,
    defaultTtlMs = DEFAULT_LEASE_TTL_MS,
    defaultCapacity = 1,
    now = () => Date.now(),
    idFactory = () => randomUUID(),
    autoSweep = true,
    sweepIntervalMs,
  } = {}) {
    super();
    this.defaultTtlMs = positiveFinite(defaultTtlMs, 'defaultTtlMs');
    this.defaultCapacity = positiveInteger(defaultCapacity, 'defaultCapacity');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function');
    this._now = now;
    this._idFactory = idFactory;
    this._capacities = normalizeCapacities(capacities);
    this._leases = new Map();
    this._leasesByKey = new Map();
    this._queues = new Map();
    this._queuedById = new Map();
    this._closed = false;
    this._timer = null;

    if (autoSweep) {
      const interval = positiveFinite(
        sweepIntervalMs ?? Math.max(250, Math.min(1_000, this.defaultTtlMs / 2)),
        'sweepIntervalMs',
      );
      this._timer = setInterval(() => this.sweep(), interval);
      this._timer.unref?.();
    }
  }

  now() {
    const value = this._now();
    if (!Number.isFinite(value)) throw new TypeError('now() must return a finite number');
    return value;
  }

  capacityFor(resourceKey) {
    const key = nonEmptyString(resourceKey, 'resourceKey');
    return this._capacities.get(key) ?? defaultLeaseCapacity(key) ?? this.defaultCapacity;
  }

  setCapacity(resourceKey, capacity) {
    this._assertOpen();
    const key = nonEmptyString(resourceKey, 'resourceKey');
    this._capacities.set(key, positiveInteger(capacity, 'capacity'));
    this._drain(key);
    return this.capacityFor(key);
  }

  /**
   * Queue a FIFO lease request. The returned handle is thenable, so both
   * `await manager.acquire(...)` and `await handle.promise` are supported.
   */
  acquire(resourceKey, options = {}) {
    this._assertOpen();
    const key = nonEmptyString(resourceKey, 'resourceKey');
    const identity = normalizeIdentity(options);
    const ttlMs = positiveFinite(options.ttlMs ?? this.defaultTtlMs, 'ttlMs');
    const requestId = String(this._idFactory());
    const queuedAt = this.now();
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const request = {
      requestId,
      key,
      ...identity,
      ttlMs,
      queuedAt,
      status: 'queued',
      resolve: resolvePromise,
      reject: rejectPromise,
      signal: options.signal ?? null,
      abortListener: null,
    };

    const manager = this;
    const handle = Object.freeze({
      requestId,
      promise,
      get status() { return request.status; },
      cancel(reason) {
        return manager.cancel(requestId, { ...identity, reason });
      },
      then(onFulfilled, onRejected) { return promise.then(onFulfilled, onRejected); },
      catch(onRejected) { return promise.catch(onRejected); },
      finally(onFinally) { return promise.finally(onFinally); },
    });

    if (request.signal != null) {
      if (typeof request.signal.addEventListener !== 'function') {
        throw new TypeError('signal must be an AbortSignal');
      }
      request.abortListener = () => {
        this.cancel(requestId, {
          ...identity,
          reason: request.signal.reason ?? 'Lease request aborted',
        });
      };
    }

    this.sweep(queuedAt);
    if (request.signal?.aborted) {
      request.status = 'cancelled';
      queueMicrotask(() => rejectPromise(new LeaseCancelledError(requestId, request.signal.reason)));
      return handle;
    }

    if (this._canGrant(key) && this._queueFor(key).length === 0) {
      this._grant(request, queuedAt);
    } else {
      this._queueFor(key).push(request);
      this._queuedById.set(requestId, request);
      request.signal?.addEventListener('abort', request.abortListener, { once: true });
      this.emit('queued', queuedSnapshot(request));
    }
    return handle;
  }

  /** Acquire immediately without jumping ahead of existing FIFO waiters. */
  tryAcquire(resourceKey, options = {}) {
    this._assertOpen();
    const key = nonEmptyString(resourceKey, 'resourceKey');
    const identity = normalizeIdentity(options);
    const ttlMs = positiveFinite(options.ttlMs ?? this.defaultTtlMs, 'ttlMs');
    const now = this.now();
    this.sweep(now);
    if (this._queueFor(key).length > 0 || !this._canGrant(key)) return null;

    const request = {
      requestId: String(this._idFactory()),
      key,
      ...identity,
      ttlMs,
      queuedAt: now,
      status: 'queued',
      resolve() {},
      reject() {},
      signal: null,
      abortListener: null,
    };
    return this._grant(request, now);
  }

  cancel(request, options = {}) {
    const requestId = requestIdentifier(request);
    const queued = this._queuedById.get(requestId);
    if (!queued) return false;
    const identity = normalizeIdentity(options);
    this._assertIdentity(queued, identity);
    this._cancelQueued(queued, options.reason);
    return true;
  }

  heartbeat(lease, options = {}) {
    const token = leaseToken(lease);
    const identity = normalizeIdentity(options);
    const now = this.now();
    this.sweep(now);
    const current = this._leases.get(token);
    if (!current) throw new LeaseNotFoundError(token);
    this._assertIdentity(current, identity);
    const ttlMs = positiveFinite(options.ttlMs ?? current.ttlMs, 'ttlMs');
    const recovered = current.state === 'orphaned';
    current.state = 'active';
    current.ttlMs = ttlMs;
    current.heartbeatAt = now;
    current.expiresAt = now + ttlMs;
    current.orphanedAt = null;
    const snapshot = leaseSnapshot(current);
    this.emit(recovered ? 'recovered' : 'heartbeat', snapshot);
    return snapshot;
  }

  release(lease, options = {}) {
    const token = leaseToken(lease);
    const identity = normalizeIdentity(options);
    const current = this._leases.get(token);
    if (!current) throw new LeaseNotFoundError(token);
    this._assertIdentity(current, identity);

    current.state = 'released';
    current.releasedAt = this.now();
    this._leases.delete(token);
    const tokens = this._leasesByKey.get(current.key);
    tokens?.delete(token);
    if (tokens?.size === 0) this._leasesByKey.delete(current.key);
    const snapshot = Object.freeze({ ...leaseSnapshot(current), releasedAt: current.releasedAt });
    this.emit('released', snapshot);
    this._drain(current.key);
    return snapshot;
  }

  getLease(lease) {
    const token = leaseToken(lease);
    this.sweep();
    const current = this._leases.get(token);
    return current ? leaseSnapshot(current) : null;
  }

  list({ key } = {}) {
    this.sweep();
    const normalizedKey = key == null ? null : nonEmptyString(key, 'key');
    return [...this._leases.values()]
      .filter((lease) => normalizedKey == null || lease.key === normalizedKey)
      .map(leaseSnapshot);
  }

  listQueued({ key } = {}) {
    const normalizedKey = key == null ? null : nonEmptyString(key, 'key');
    return [...this._queuedById.values()]
      .filter((request) => normalizedKey == null || request.key === normalizedKey)
      .sort((left, right) => left.queuedAt - right.queuedAt)
      .map(queuedSnapshot);
  }

  sweep(at = this.now()) {
    if (!Number.isFinite(at)) throw new TypeError('sweep time must be finite');
    const orphaned = [];
    for (const lease of this._leases.values()) {
      if (lease.state !== 'active' || lease.expiresAt > at) continue;
      lease.state = 'orphaned';
      lease.orphanedAt = at;
      const snapshot = leaseSnapshot(lease);
      orphaned.push(snapshot);
      this.emit('orphaned', snapshot);
      // Intentionally do not release capacity or drain the queue here.
    }
    return orphaned;
  }

  close({ cancelQueued = true } = {}) {
    if (this._closed) return;
    this._closed = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (cancelQueued) {
      for (const request of [...this._queuedById.values()]) {
        this._cancelQueued(request, 'Lease manager closed');
      }
    }
  }

  _grant(request, at = this.now()) {
    request.status = 'granted';
    this._queuedById.delete(request.requestId);
    request.signal?.removeEventListener('abort', request.abortListener);
    const lease = {
      token: String(this._idFactory()),
      requestId: request.requestId,
      key: request.key,
      ownerId: request.ownerId,
      sessionNonce: request.sessionNonce,
      state: 'active',
      ttlMs: request.ttlMs,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at + request.ttlMs,
      orphanedAt: null,
    };
    this._leases.set(lease.token, lease);
    if (!this._leasesByKey.has(lease.key)) this._leasesByKey.set(lease.key, new Set());
    this._leasesByKey.get(lease.key).add(lease.token);
    const snapshot = leaseSnapshot(lease);
    request.resolve(snapshot);
    this.emit('granted', snapshot);
    return snapshot;
  }

  _cancelQueued(request, reason) {
    if (request.status !== 'queued') return;
    request.status = 'cancelled';
    this._queuedById.delete(request.requestId);
    request.signal?.removeEventListener('abort', request.abortListener);
    const queue = this._queues.get(request.key);
    if (queue) {
      const index = queue.indexOf(request);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this._queues.delete(request.key);
    }
    const error = new LeaseCancelledError(request.requestId, reason);
    request.reject(error);
    this.emit('cancelled', queuedSnapshot(request));
  }

  _drain(key) {
    const queue = this._queues.get(key);
    if (!queue) return;
    while (queue.length > 0 && this._canGrant(key)) {
      const request = queue.shift();
      if (request.status !== 'queued') continue;
      this._grant(request);
    }
    if (queue.length === 0) this._queues.delete(key);
  }

  _queueFor(key) {
    let queue = this._queues.get(key);
    if (!queue) {
      queue = [];
      this._queues.set(key, queue);
    }
    return queue;
  }

  _canGrant(key) {
    return (this._leasesByKey.get(key)?.size ?? 0) < this.capacityFor(key);
  }

  _assertIdentity(record, identity) {
    if (record.ownerId !== identity.ownerId || record.sessionNonce !== identity.sessionNonce) {
      throw new LeaseIdentityError();
    }
  }

  _assertOpen() {
    if (this._closed) throw new LeaseError('Lease manager is closed', 'LEASE_MANAGER_CLOSED');
  }
}
