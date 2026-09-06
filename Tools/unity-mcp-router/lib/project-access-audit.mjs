import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NULL_LOGGER } from './logger.mjs';

const PROBE_FILE = fileURLToPath(import.meta.url);
const PROBE_SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_ACTIVE_PROBES = 8;

function isoNow() {
  return new Date().toISOString();
}

function projectPathOf(project) {
  return project?.canonicalPath ?? project?.path;
}

function projectNameOf(project) {
  return project?.name ?? project?.aliases?.[0] ?? project?.key ?? projectPathOf(project);
}

function decimalIdentityPart(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

function expectedIdentityOf(project) {
  const dev = decimalIdentityPart(project?.identity?.dev);
  const ino = decimalIdentityPart(project?.identity?.ino);
  if (dev == null || ino == null) return null;
  return Object.freeze({ dev, ino });
}

function identityKey(identity) {
  return identity == null ? null : `dev:${identity.dev}:ino:${identity.ino}`;
}

function remediationFor(code, projectPath, executable = process.execPath) {
  if (code === 'DEADLINE_EXCEEDED') {
    return 'Retry after the current queue clears; the caller deadline expired before the access probe completed.';
  }
  if (code === 'PROJECT_IDENTITY_MISMATCH') {
    return 'Do not dispatch Unity work. Verify the mounted checkout, then regenerate and reinstall the immutable router config.';
  }
  if (code === 'PROJECT_ACCESS_DENIED') {
    return `Allow Removable Volumes access for ${executable}, then run unity_router_doctor again.`;
  }
  if (code === 'PROJECT_ACCESS_PROBE_TIMEOUT' && projectPath.startsWith('/Volumes/')) {
    return `Verify that ${projectPath} is mounted and responsive, and allow Removable Volumes access for ${executable}.`;
  }
  if (code === 'PROJECT_NOT_UNITY_PROJECT') {
    return 'Verify the configured canonical project path and its Assets and ProjectSettings directories.';
  }
  if (code === 'PROJECT_ACCESS_PROBE_CAPACITY') {
    return 'One or more prior access probes are still terminating. Restore volume responsiveness before retrying.';
  }
  return `Verify that ${projectPath} is mounted, responsive, and readable by ${executable}.`;
}

function resultBase({
  ok,
  code,
  projectPath,
  projectKey,
  expectedIdentity,
  observedIdentity = null,
  likelyCause,
  remediation,
  details = {},
  executable = process.execPath,
}) {
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    ok,
    code,
    projectPath,
    projectKey,
    expectedIdentity,
    observedIdentity,
    checkedAt: isoNow(),
    likelyCause,
    remediation: remediation === undefined
      ? remediationFor(code, projectPath, executable)
      : remediation,
    details,
  };
}

export function classifyProjectAccessError(
  error,
  projectPath,
  executable = process.execPath,
  { projectKey = null, expectedIdentity = null, observedIdentity = null } = {},
) {
  const errorCode = typeof error?.code === 'string' ? error.code : null;
  let code;
  let likelyCause;
  if (errorCode === 'EPERM' || errorCode === 'EACCES') {
    code = 'PROJECT_ACCESS_DENIED';
    likelyCause = projectPath.startsWith('/Volumes/')
      ? 'REMOVABLE_VOLUME_PRIVACY_DENIED'
      : 'FILESYSTEM_PERMISSION_DENIED';
  } else if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
    code = 'PROJECT_NOT_UNITY_PROJECT';
    likelyCause = 'MISSING_UNITY_PROJECT_STRUCTURE';
  } else {
    code = 'PROJECT_VOLUME_UNAVAILABLE';
    likelyCause = projectPath.startsWith('/Volumes/')
      ? 'REMOVABLE_VOLUME_UNAVAILABLE'
      : 'FILESYSTEM_UNAVAILABLE';
  }
  return resultBase({
    ok: false,
    code,
    projectPath,
    projectKey,
    expectedIdentity,
    observedIdentity,
    likelyCause,
    executable,
    details: {
      errorCode,
      syscall: typeof error?.syscall === 'string' ? error.syscall : null,
      path: typeof error?.path === 'string' ? error.path : null,
    },
  });
}

function runProbe(projectPath, projectKey, expectedDev, expectedIno) {
  const expectedIdentity = { dev: expectedDev, ino: expectedIno };
  let observedIdentity = null;
  try {
    if (
      typeof projectPath !== 'string'
      || projectPath.length === 0
      || !path.isAbsolute(projectPath)
      || identityKey(expectedIdentity) !== projectKey
    ) {
      return resultBase({
        ok: false,
        code: 'PROJECT_ACCESS_PROBE_INVALID',
        projectPath,
        projectKey,
        expectedIdentity,
        likelyCause: 'INVALID_EXPECTED_PROJECT_IDENTITY',
      });
    }
    const rootStat = statSync(projectPath);
    if (!rootStat.isDirectory()) {
      const error = Object.assign(new Error('project path is not a directory'), {
        code: 'ENOTDIR',
        path: projectPath,
      });
      throw error;
    }
    observedIdentity = { dev: String(rootStat.dev), ino: String(rootStat.ino) };
    if (identityKey(observedIdentity) !== projectKey) {
      return resultBase({
        ok: false,
        code: 'PROJECT_IDENTITY_MISMATCH',
        projectPath,
        projectKey,
        expectedIdentity,
        observedIdentity,
        likelyCause: 'PROJECT_PATH_REPLACED_OR_REMOUNTED',
        details: { expectedKey: projectKey, observedKey: identityKey(observedIdentity) },
      });
    }
    for (const requiredPath of [
      path.join(projectPath, 'Assets'),
      path.join(projectPath, 'ProjectSettings'),
    ]) {
      const stat = statSync(requiredPath);
      if (!stat.isDirectory()) {
        const error = Object.assign(new Error('required Unity project path is not a directory'), {
          code: 'ENOTDIR',
          path: requiredPath,
        });
        throw error;
      }
    }
    return resultBase({
      ok: true,
      code: 'PROJECT_ACCESS_OK',
      projectPath,
      projectKey,
      expectedIdentity,
      observedIdentity,
      likelyCause: null,
      remediation: null,
      details: {},
    });
  } catch (error) {
    return classifyProjectAccessError(error, projectPath, process.execPath, {
      projectKey,
      expectedIdentity,
      observedIdentity,
    });
  }
}

function isProbeInvocation() {
  return process.argv[2] === '--probe'
    && process.argv[1] != null
    && path.resolve(process.argv[1]) === path.resolve(PROBE_FILE);
}

if (isProbeInvocation()) {
  process.stdout.write(`${JSON.stringify(runProbe(
    process.argv[3],
    process.argv[4],
    process.argv[5],
    process.argv[6],
  ))}\n`);
}

function validIdentity(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && decimalIdentityPart(value.dev) != null
    && decimalIdentityPart(value.ino) != null;
}

function validateProbeResult(value, expected) {
  if (
    value == null
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== PROBE_SCHEMA_VERSION
    || typeof value.ok !== 'boolean'
    || typeof value.code !== 'string'
    || value.projectPath !== expected.projectPath
    || value.projectKey !== expected.projectKey
    || !validIdentity(value.expectedIdentity)
    || identityKey(value.expectedIdentity) !== expected.projectKey
    || (value.observedIdentity !== null && !validIdentity(value.observedIdentity))
    || typeof value.checkedAt !== 'string'
    || Number.isNaN(Date.parse(value.checkedAt))
    || (value.likelyCause !== null && typeof value.likelyCause !== 'string')
    || (value.remediation !== null && typeof value.remediation !== 'string')
    || value.details == null
    || typeof value.details !== 'object'
    || Array.isArray(value.details)
  ) {
    throw new Error('project access probe returned an invalid result');
  }
  if (value.ok !== (value.code === 'PROJECT_ACCESS_OK')) {
    throw new Error('project access probe result is internally inconsistent');
  }
  if (value.ok && identityKey(value.observedIdentity) !== expected.projectKey) {
    throw new Error('successful project access probe did not prove the expected identity');
  }
  return value;
}

export class ProjectAccessError extends Error {
  constructor(result) {
    super(`Project access gate failed for ${result.projectPath}: ${result.code}`);
    this.name = 'ProjectAccessError';
    this.code = result.code;
    this.details = result;
  }
}

export class ProjectAccessAuditor {
  constructor({
    projects = [],
    executable = process.execPath,
    probeFile = PROBE_FILE,
    spawnProcess = spawn,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    successTtlMs = 30_000,
    failureTtlMs = 2_000,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxActiveProbes = DEFAULT_MAX_ACTIVE_PROBES,
    logger = NULL_LOGGER,
  } = {}) {
    this.projects = projects;
    this.executable = executable;
    this.probeFile = probeFile;
    this.spawnProcess = spawnProcess;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.successTtlMs = successTtlMs;
    this.failureTtlMs = failureTtlMs;
    this.maxOutputBytes = maxOutputBytes;
    this.maxActiveProbes = Math.max(1, maxActiveProbes);
    this.logger = logger.child({ component: 'project-access-auditor' });
    this.cache = new Map();
    this.inFlight = new Map();
    this.terminating = new Map();
    this.activeChildren = new Map();
    this.closed = false;
  }

  snapshot() {
    const now = Date.now();
    const projects = this.projects.map((project) => {
      const descriptor = this.#descriptor(project);
      const cached = this.cache.get(descriptor.projectKey);
      const terminating = this.terminating.get(descriptor.projectKey);
      if (!cached && !terminating) {
        return {
          project: projectNameOf(project),
          projectKey: descriptor.projectKey,
          projectPath: descriptor.projectPath,
          expectedIdentity: descriptor.expectedIdentity,
          observedIdentity: null,
          ok: null,
          code: 'PROJECT_ACCESS_NOT_CHECKED',
          stale: true,
        };
      }
      const value = cached?.value ?? this.#decorate(project, terminating.result);
      return { ...value, stale: terminating == null && cached.expiresAt <= now };
    });
    const checked = projects.filter((project) => project.ok !== null);
    return {
      ok: checked.some((project) => !project.ok)
        ? false
        : checked.length === projects.length ? true : null,
      responsibleExecutable: this.executable,
      timeoutMs: this.timeoutMs,
      activeProbes: this.activeChildren.size,
      maxActiveProbes: this.maxActiveProbes,
      projects,
    };
  }

  async audit(project, { force = false, deadlineAt } = {}) {
    const descriptor = this.#descriptor(project);
    const remainingMs = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    if (remainingMs <= 0) return this.#deadlineResult(project, descriptor);

    const terminating = this.terminating.get(descriptor.projectKey);
    if (terminating) {
      return this.#withCallerDeadline(
        Promise.resolve(this.#decorate(project, terminating.result)),
        project,
        descriptor,
        deadlineAt,
      );
    }
    const existing = this.inFlight.get(descriptor.projectKey);
    if (existing) return this.#withCallerDeadline(existing, project, descriptor, deadlineAt);
    const cached = this.cache.get(descriptor.projectKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const promise = this.#run(descriptor).then((result) => {
      const value = this.#decorate(project, result);
      const ttlMs = value.ok ? this.successTtlMs : this.failureTtlMs;
      this.cache.set(descriptor.projectKey, { value, expiresAt: Date.now() + ttlMs });
      return value;
    }).finally(() => {
      if (this.inFlight.get(descriptor.projectKey) === promise) {
        this.inFlight.delete(descriptor.projectKey);
      }
    });
    this.inFlight.set(descriptor.projectKey, promise);
    return this.#withCallerDeadline(promise, project, descriptor, deadlineAt);
  }

  async assertAccessible(project, options = {}) {
    const result = await this.audit(project, options);
    if (!result.ok) throw new ProjectAccessError(result);
    return result;
  }

  async auditAll(projects = this.projects, { force = true, deadlineAt } = {}) {
    const results = [];
    // Audit every configured project without exhausting the bounded helper pool.
    // Stalled helpers remain quarantined and still count against the global cap.
    for (let start = 0; start < projects.length; start += this.maxActiveProbes) {
      const batch = projects.slice(start, start + this.maxActiveProbes);
      results.push(...await Promise.all(batch.map((project) =>
        this.audit(project, { force, deadlineAt }))));
    }
    return {
      ok: results.every((result) => result.ok),
      responsibleExecutable: this.executable,
      timeoutMs: this.timeoutMs,
      checkedAt: isoNow(),
      activeProbes: this.activeChildren.size,
      maxActiveProbes: this.maxActiveProbes,
      projects: results,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const closing = [...this.activeChildren.values()].map((record) => record.closed);
    for (const { child } of this.activeChildren.values()) {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    if (closing.length > 0) {
      await Promise.race([
        Promise.allSettled(closing),
        new Promise((resolve) => setTimeout(resolve, Math.min(1_000, this.timeoutMs))),
      ]);
    }
  }

  #descriptor(project) {
    const projectPath = projectPathOf(project);
    const expectedIdentity = expectedIdentityOf(project);
    const projectKey = project?.key;
    if (
      typeof projectPath !== 'string'
      || projectPath.length === 0
      || expectedIdentity == null
      || projectKey !== identityKey(expectedIdentity)
    ) {
      throw new TypeError('project path and exact dev/ino identity are required for access audit');
    }
    return { projectPath, projectKey, expectedIdentity };
  }

  #decorate(project, result) {
    return {
      ...result,
      project: projectNameOf(project),
      responsibleExecutable: this.executable,
    };
  }

  #deadlineResult(project, descriptor) {
    return this.#decorate(project, resultBase({
      ok: false,
      code: 'DEADLINE_EXCEEDED',
      projectPath: descriptor.projectPath,
      projectKey: descriptor.projectKey,
      expectedIdentity: descriptor.expectedIdentity,
      likelyCause: 'CALLER_DEADLINE_EXPIRED',
      executable: this.executable,
    }));
  }

  #withCallerDeadline(promise, project, descriptor, deadlineAt) {
    if (!Number.isFinite(deadlineAt)) return promise;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return Promise.resolve(this.#deadlineResult(project, descriptor));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(this.#deadlineResult(project, descriptor)), remainingMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  #failure(descriptor, code, likelyCause, details = {}) {
    return resultBase({
      ok: false,
      code,
      projectPath: descriptor.projectPath,
      projectKey: descriptor.projectKey,
      expectedIdentity: descriptor.expectedIdentity,
      likelyCause,
      executable: this.executable,
      details,
    });
  }

  #run(descriptor) {
    if (this.closed) {
      return Promise.resolve(this.#failure(
        descriptor,
        'PROJECT_ACCESS_AUDITOR_CLOSED',
        'BROKER_SHUTTING_DOWN',
      ));
    }
    if (this.activeChildren.size >= this.maxActiveProbes) {
      return Promise.resolve(this.#failure(
        descriptor,
        'PROJECT_ACCESS_PROBE_CAPACITY',
        'STALLED_PROBE_CAPACITY_EXHAUSTED',
        { activeProbes: this.activeChildren.size, maxActiveProbes: this.maxActiveProbes },
      ));
    }

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnProcess(this.executable, [
          this.probeFile,
          '--probe',
          descriptor.projectPath,
          descriptor.projectKey,
          descriptor.expectedIdentity.dev,
          descriptor.expectedIdentity.ino,
        ], {
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve(this.#failure(descriptor, 'PROJECT_ACCESS_PROBE_FAILED', 'PROBE_PROCESS_START_FAILED', {
          errorCode: error?.code ?? null,
        }));
        return;
      }

      let settled = false;
      let stdout = '';
      let stdoutBytes = 0;
      let timer = null;
      let closeResolve;
      const closed = new Promise((resolveClosed) => { closeResolve = resolveClosed; });
      const record = { child, closed };
      this.activeChildren.set(child, record);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const quarantine = (value) => {
        this.terminating.set(descriptor.projectKey, { child, result: value });
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        finish(value);
      };

      timer = setTimeout(() => quarantine(this.#failure(
        descriptor,
        'PROJECT_ACCESS_PROBE_TIMEOUT',
        descriptor.projectPath.startsWith('/Volumes/')
          ? 'REMOVABLE_VOLUME_PRIVACY_OR_STALLED_VOLUME'
          : 'FILESYSTEM_PROBE_STALLED',
        { timeoutMs: this.timeoutMs },
      )), this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxOutputBytes) {
          quarantine(this.#failure(
            descriptor,
            'PROJECT_ACCESS_PROBE_INVALID',
            'PROBE_OUTPUT_LIMIT_EXCEEDED',
            { maxOutputBytes: this.maxOutputBytes },
          ));
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', () => {});
      child.once('error', (error) => finish(this.#failure(
        descriptor,
        'PROJECT_ACCESS_PROBE_FAILED',
        'PROBE_PROCESS_START_FAILED',
        { errorCode: error?.code ?? null },
      )));
      child.once('close', (code, signal) => {
        this.activeChildren.delete(child);
        if (this.terminating.get(descriptor.projectKey)?.child === child) {
          this.terminating.delete(descriptor.projectKey);
        }
        closeResolve();
        if (settled) return;
        if (this.closed) {
          finish(this.#failure(
            descriptor,
            'PROJECT_ACCESS_AUDITOR_CLOSED',
            'BROKER_SHUTTING_DOWN',
          ));
          return;
        }
        if (code !== 0 || signal != null) {
          finish(this.#failure(
            descriptor,
            'PROJECT_ACCESS_PROBE_FAILED',
            'PROBE_PROCESS_EXITED',
            { exitCode: code, signal },
          ));
          return;
        }
        try {
          finish(validateProbeResult(JSON.parse(stdout.trim()), descriptor));
        } catch (error) {
          finish(this.#failure(
            descriptor,
            'PROJECT_ACCESS_PROBE_INVALID',
            'PROBE_OUTPUT_INVALID',
            { error: error.message, stdoutBytes },
          ));
        }
      });
    });
  }
}
