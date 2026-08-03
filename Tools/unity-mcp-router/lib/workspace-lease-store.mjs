import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_WORKSPACE_FS_OPS = Object.freeze({
  chmod, lstat, mkdir, open, readFile, rename, unlink,
});

export class WorkspaceLeaseStoreError extends Error {
  constructor(code, message, { committed = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkspaceLeaseStoreError';
    this.code = code;
    this.committed = committed;
  }
}

function clone(value) {
  return value == null ? null : structuredClone(value);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('workspace lease record must be an object');
  for (const key of ['token', 'projectKey', 'projectName', 'ownerId', 'sessionNonce']) {
    if (typeof record[key] !== 'string' || !record[key] || /[\u0000-\u001f\u007f]/.test(record[key])) {
      throw new Error(`invalid workspace lease ${key}`);
    }
  }
  for (const key of ['acquiredAt', 'heartbeatAt', 'expiresAt']) {
    if (!Number.isFinite(record[key])) throw new Error(`invalid workspace lease ${key}`);
  }
  return Object.freeze({
    token: record.token,
    projectKey: record.projectKey,
    projectName: record.projectName,
    ownerId: record.ownerId,
    sessionNonce: record.sessionNonce,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
  });
}

export class WorkspaceLeaseStore {
  constructor(filePath, records, fsOps = DEFAULT_WORKSPACE_FS_OPS) {
    this.filePath = filePath;
    this.records = records;
    this.fs = fsOps;
    this.tail = Promise.resolve();
    this.fatalError = null;
  }

  static async open(filePath, { fsOps = DEFAULT_WORKSPACE_FS_OPS } = {}) {
    const directoryPath = path.dirname(filePath);
    let directoryExisted = true;
    try { await fsOps.lstat(directoryPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      directoryExisted = false;
      await fsOps.mkdir(directoryPath, { recursive: true, mode: 0o700 });
    }
    const directoryStat = await fsOps.lstat(directoryPath);
    const uid = process.getuid?.();
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new WorkspaceLeaseStoreError('WORKSPACE_STORE_UNSAFE_PATH', 'workspace lease directory must be a real directory');
    }
    if (uid != null && directoryStat.uid !== uid) {
      throw new WorkspaceLeaseStoreError('WORKSPACE_STORE_OWNER_MISMATCH', 'workspace lease directory is owned by another user');
    }
    if (directoryExisted && (directoryStat.mode & 0o077) !== 0) {
      throw new WorkspaceLeaseStoreError(
        'WORKSPACE_STORE_UNSAFE_PERMISSIONS',
        'workspace lease directory must not be accessible by group or other users',
      );
    }
    if (!directoryExisted) await fsOps.chmod(directoryPath, 0o700);
    let payload = { version: 1, leases: [] };
    try {
      const fileStat = await fsOps.lstat(filePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new WorkspaceLeaseStoreError('WORKSPACE_STORE_UNSAFE_PATH', 'workspace lease file must be a regular file');
      }
      if (uid != null && fileStat.uid !== uid) {
        throw new WorkspaceLeaseStoreError('WORKSPACE_STORE_OWNER_MISMATCH', 'workspace lease file is owned by another user');
      }
      await fsOps.chmod(filePath, 0o600);
      payload = JSON.parse(await fsOps.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (payload.version !== 1 || !Array.isArray(payload.leases)) throw new Error('invalid workspace lease store');
    const records = new Map();
    for (const raw of payload.leases) {
      const record = validateRecord(raw);
      if (records.has(record.token)) throw new Error(`duplicate workspace lease token: ${record.token}`);
      records.set(record.token, record);
    }
    if (records.size > 1) {
      throw new Error(
        'workspace lease store contains more than one global source-refresh lease; explicit reconciliation is required',
      );
    }
    return new WorkspaceLeaseStore(filePath, records, fsOps);
  }

  create(input) {
    const now = Date.now();
    return validateRecord({
      ...input,
      token: input.token ?? randomUUID(),
      acquiredAt: input.acquiredAt ?? now,
      heartbeatAt: input.heartbeatAt ?? now,
    });
  }

  list() { return [...this.records.values()].map(clone); }
  get(token) { return clone(this.records.get(token)); }
  health() {
    return this.fatalError
      ? { ok: false, code: this.fatalError.code, message: this.fatalError.message }
      : { ok: true };
  }

  upsert(input) {
    const record = validateRecord(input);
    return this.#enqueue(async () => {
      if (!this.records.has(record.token) && this.records.size > 0) {
        throw new Error('a global source-refresh workspace lease is already persisted');
      }
      const prior = this.records.get(record.token);
      this.records.set(record.token, record);
      try {
        await this.#persist();
      } catch (error) {
        if (!error.committed) {
          if (prior) this.records.set(record.token, prior);
          else this.records.delete(record.token);
        } else this.fatalError = error;
        throw error;
      }
      return clone(record);
    });
  }

  remove(token) {
    return this.#enqueue(async () => {
      const prior = this.records.get(token);
      if (!prior) return null;
      this.records.delete(token);
      try {
        await this.#persist();
      } catch (error) {
        if (!error.committed) this.records.set(token, prior);
        else this.fatalError = error;
        throw error;
      }
      return clone(prior);
    });
  }

  async close() { await this.tail; }

  #enqueue(work) {
    const result = this.tail.then(() => {
      if (this.fatalError) throw this.fatalError;
      return work();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist() {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, leases: this.list() }, null, 2)}\n`);
    let committed = false;
    let handle;
    try {
      handle = await this.fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(temporary, this.filePath);
      committed = true;
      const directory = await this.fs.open(path.dirname(this.filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (cause) {
      try { await handle?.close(); } catch { /* preserve the original failure */ }
      if (!committed) {
        try { await this.fs.unlink(temporary); } catch { /* temp may not exist */ }
      }
      throw new WorkspaceLeaseStoreError(
        committed ? 'WORKSPACE_STORE_DURABILITY_UNCERTAIN' : 'WORKSPACE_STORE_WRITE_FAILED',
        committed
          ? 'workspace lease rename committed but directory durability could not be confirmed'
          : 'workspace lease update could not be committed',
        { committed, cause },
      );
    }
  }
}

export const NULL_WORKSPACE_LEASE_STORE = Object.freeze({
  create(input) {
    const now = Date.now();
    return { ...input, token: input.token ?? randomUUID(), acquiredAt: now, heartbeatAt: now };
  },
  list() { return []; },
  get() { return null; },
  health() { return { ok: true }; },
  async upsert(record) { return record; },
  async remove() { return null; },
  async close() {},
});
