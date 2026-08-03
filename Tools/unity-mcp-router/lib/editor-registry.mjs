import { realpathSync } from 'node:fs';
import path from 'node:path';

import { LeaseManager } from './lease-manager.mjs';

export class EditorRegistryError extends Error {
  constructor(message, code = 'EDITOR_REGISTRY_ERROR', details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class DuplicateProjectError extends EditorRegistryError {
  constructor(projectId) {
    super(`Unity project is already registered: ${projectId}`, 'DUPLICATE_PROJECT', { projectId });
  }
}

export class DuplicatePidError extends EditorRegistryError {
  constructor(pid) {
    super(`Unity Editor PID is already registered: ${pid}`, 'DUPLICATE_EDITOR_PID', { pid });
  }
}

export class EditorSeatCapacityError extends EditorRegistryError {
  constructor(capacity) {
    super(`Unity Editor seat capacity reached (${capacity})`, 'EDITOR_SEAT_CAPACITY_REACHED', { capacity });
  }
}

export class EditorIdentityError extends EditorRegistryError {
  constructor() {
    super('Unity Editor identity does not match the registered session', 'EDITOR_IDENTITY_MISMATCH');
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positivePid(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('pid must be a positive safe integer');
  }
  return value;
}

function normalizeMode(value) {
  if (value !== 'managed' && value !== 'external') {
    throw new TypeError("mode must be 'managed' or 'external'");
  }
  return value;
}

function canonicalLogPath(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('log paths must be strings');
  if (value === '-') return value;
  return path.resolve(value);
}

function normalizeLogPaths(input) {
  const raw = input.logPaths ?? input.logs ?? {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('logPaths must be an object');
  }
  return Object.freeze({
    editor: canonicalLogPath(raw.editor ?? raw.editorLog ?? input.editorLogPath),
    upm: canonicalLogPath(raw.upm ?? raw.upmLog ?? input.upmLogPath),
  });
}

/** Resolve aliases, symlinks, `.` and `..` so one project gets one lock key. */
export function canonicalProjectId(projectId, { cwd = process.cwd() } = {}) {
  const raw = nonEmptyString(projectId, 'projectId');
  // `config.mjs` identifies existing projects by device/inode. Preserve that
  // already-canonical opaque ID instead of accidentally treating it as a path.
  if (/^dev:[^:]+:ino:[^:]+$/.test(raw)) return raw;
  const resolved = path.resolve(cwd, raw);
  try {
    return realpathSync.native(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

function normalizeRegistration(input, canonicalize) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('editor registration must be an object');
  }
  const projectId = canonicalize(input.projectId ?? input.projectPath);
  const pid = positivePid(input.pid);
  const version = nonEmptyString(input.version ?? input.unityVersion, 'version');
  const sessionNonce = nonEmptyString(input.sessionNonce, 'sessionNonce');
  const mode = normalizeMode(input.mode);
  const ownerId = input.ownerId == null
    ? `unity-editor:${pid}`
    : nonEmptyString(input.ownerId, 'ownerId');
  return {
    projectId,
    pid,
    version,
    sessionNonce,
    mode,
    ownerId,
    logPaths: normalizeLogPaths(input),
    ttlMs: input.ttlMs,
  };
}

function normalizeIdentity(input, canonicalize) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('editor identity must be an object');
  }
  return {
    projectId: canonicalize(input.projectId ?? input.projectPath),
    pid: positivePid(input.pid),
    version: nonEmptyString(input.version ?? input.unityVersion, 'version'),
    sessionNonce: nonEmptyString(input.sessionNonce, 'sessionNonce'),
  };
}

function exactIdentity(record, identity) {
  return record.projectId === identity.projectId &&
    record.pid === identity.pid &&
    record.version === identity.version &&
    record.sessionNonce === identity.sessionNonce;
}

function logPathsEqual(left, right) {
  return left.editor === right.editor && left.upm === right.upm;
}

function recordSnapshot(record) {
  return Object.freeze({
    projectId: record.projectId,
    pid: record.pid,
    version: record.version,
    sessionNonce: record.sessionNonce,
    mode: record.mode,
    ownerId: record.ownerId,
    logPaths: record.logPaths,
    state: record.state,
    registeredAt: record.registeredAt,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
    orphanedAt: record.orphanedAt,
    leases: Object.freeze({
      project: Object.freeze({
        key: record.projectLease.key,
        state: record.projectLease.state,
        expiresAt: record.projectLease.expiresAt,
      }),
      seat: Object.freeze({
        key: record.seatLease.key,
        state: record.seatLease.state,
        expiresAt: record.seatLease.expiresAt,
      }),
    }),
  });
}

/**
 * Registry of observed Unity Editor processes.
 *
 * It records identity and holds project/seat leases, but deliberately has no
 * process-spawn or process-kill capability. Unregistering only updates broker
 * state; the caller must separately prove that stopping an Editor is safe.
 */
export class EditorRegistry {
  constructor(options = {}) {
    const {
      leaseManager,
      defaultTtlMs,
      now,
      autoSweep,
      canonicalizeProjectId = canonicalProjectId,
    } = options;
    if (typeof canonicalizeProjectId !== 'function') {
      throw new TypeError('canonicalizeProjectId must be a function');
    }
    this._canonicalize = (value) => canonicalizeProjectId(value);
    this._ownsLeaseManager = leaseManager == null;
    this.leaseManager = leaseManager ?? new LeaseManager({ defaultTtlMs, now, autoSweep });
    if (typeof this.leaseManager.tryAcquire !== 'function') {
      throw new TypeError('leaseManager must be a LeaseManager-compatible object');
    }
    if (Object.hasOwn(options, 'seatCapacity')) {
      this.leaseManager.setCapacity('editor-seat', options.seatCapacity);
    }
    this.seatCapacity = this.leaseManager.capacityFor('editor-seat');
    this._byProject = new Map();
    this._byPid = new Map();
  }

  get size() {
    return this._byProject.size;
  }

  register(input) {
    const candidate = normalizeRegistration(input, this._canonicalize);
    this.sweep();

    const projectRecord = this._byProject.get(candidate.projectId);
    if (projectRecord) {
      if (exactIdentity(projectRecord, candidate) &&
          projectRecord.mode === candidate.mode &&
          projectRecord.ownerId === candidate.ownerId &&
          logPathsEqual(projectRecord.logPaths, candidate.logPaths)) {
        return recordSnapshot(projectRecord);
      }
      throw new DuplicateProjectError(candidate.projectId);
    }

    const pidRecord = this._byPid.get(candidate.pid);
    if (pidRecord) throw new DuplicatePidError(candidate.pid);

    const leaseIdentity = {
      ownerId: candidate.ownerId,
      sessionNonce: candidate.sessionNonce,
      ...(candidate.ttlMs == null ? {} : { ttlMs: candidate.ttlMs }),
    };
    const projectLease = this.leaseManager.tryAcquire(`project:${candidate.projectId}`, leaseIdentity);
    if (!projectLease) throw new DuplicateProjectError(candidate.projectId);

    const seatLease = this.leaseManager.tryAcquire('editor-seat', leaseIdentity);
    if (!seatLease) {
      this.leaseManager.release(projectLease, leaseIdentity);
      throw new EditorSeatCapacityError(this.seatCapacity);
    }

    const registeredAt = Math.max(projectLease.acquiredAt, seatLease.acquiredAt);
    const record = {
      ...candidate,
      state: 'active',
      registeredAt,
      heartbeatAt: registeredAt,
      expiresAt: Math.min(projectLease.expiresAt, seatLease.expiresAt),
      orphanedAt: null,
      projectLease,
      seatLease,
    };
    this._byProject.set(record.projectId, record);
    this._byPid.set(record.pid, record);
    return recordSnapshot(record);
  }

  findExact(input) {
    const identity = normalizeIdentity(input, this._canonicalize);
    this.sweep();
    const record = this._byProject.get(identity.projectId);
    return record && exactIdentity(record, identity) ? recordSnapshot(record) : null;
  }

  getByProject(projectId) {
    const canonical = this._canonicalize(projectId);
    this.sweep();
    const record = this._byProject.get(canonical);
    return record ? recordSnapshot(record) : null;
  }

  getByPid(pid) {
    const normalizedPid = positivePid(pid);
    this.sweep();
    const record = this._byPid.get(normalizedPid);
    return record ? recordSnapshot(record) : null;
  }

  list({ mode, state } = {}) {
    if (mode != null) normalizeMode(mode);
    if (state != null && state !== 'active' && state !== 'orphaned') {
      throw new TypeError("state must be 'active' or 'orphaned'");
    }
    this.sweep();
    return [...this._byProject.values()]
      .filter((record) => mode == null || record.mode === mode)
      .filter((record) => state == null || record.state === state)
      .map(recordSnapshot);
  }

  heartbeat(input, { ttlMs } = {}) {
    const identity = normalizeIdentity(input, this._canonicalize);
    const record = this._requireExact(identity);
    const leaseIdentity = {
      ownerId: record.ownerId,
      sessionNonce: record.sessionNonce,
      ...(ttlMs == null ? {} : { ttlMs }),
    };
    record.projectLease = this.leaseManager.heartbeat(record.projectLease, leaseIdentity);
    record.seatLease = this.leaseManager.heartbeat(record.seatLease, leaseIdentity);
    record.state = 'active';
    record.heartbeatAt = Math.max(record.projectLease.heartbeatAt, record.seatLease.heartbeatAt);
    record.expiresAt = Math.min(record.projectLease.expiresAt, record.seatLease.expiresAt);
    record.orphanedAt = null;
    return recordSnapshot(record);
  }

  unregister(input) {
    const identity = normalizeIdentity(input, this._canonicalize);
    const record = this._requireExact(identity);
    const leaseIdentity = {
      ownerId: record.ownerId,
      sessionNonce: record.sessionNonce,
    };

    // No signal is ever sent to the Editor process here.
    this.leaseManager.release(record.projectLease, leaseIdentity);
    this.leaseManager.release(record.seatLease, leaseIdentity);
    this._byProject.delete(record.projectId);
    this._byPid.delete(record.pid);
    return recordSnapshot({
      ...record,
      state: 'unregistered',
      projectLease: { ...record.projectLease, state: 'released' },
      seatLease: { ...record.seatLease, state: 'released' },
    });
  }

  sweep(at = this.leaseManager.now()) {
    this.leaseManager.sweep(at);
    const orphaned = [];
    for (const record of this._byProject.values()) {
      const projectLease = this.leaseManager.getLease(record.projectLease);
      const seatLease = this.leaseManager.getLease(record.seatLease);
      if (!projectLease || !seatLease) {
        throw new EditorRegistryError(
          `Lease state disappeared for registered Editor ${record.pid}`,
          'EDITOR_LEASE_INCONSISTENT',
          { projectId: record.projectId, pid: record.pid },
        );
      }
      record.projectLease = projectLease;
      record.seatLease = seatLease;
      record.expiresAt = Math.min(projectLease.expiresAt, seatLease.expiresAt);
      const isOrphaned = projectLease.state === 'orphaned' || seatLease.state === 'orphaned';
      if (isOrphaned && record.state !== 'orphaned') {
        record.state = 'orphaned';
        record.orphanedAt = Math.max(projectLease.orphanedAt ?? 0, seatLease.orphanedAt ?? 0);
        orphaned.push(recordSnapshot(record));
      }
    }
    return orphaned;
  }

  close() {
    // Closing the registry never unregisters or terminates an Editor.
    if (this._ownsLeaseManager) this.leaseManager.close({ cancelQueued: true });
  }

  _requireExact(identity) {
    this.sweep();
    const record = this._byProject.get(identity.projectId);
    if (!record || !exactIdentity(record, identity)) throw new EditorIdentityError();
    return record;
  }
}
