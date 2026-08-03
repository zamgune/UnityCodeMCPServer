import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateToolClassOverrides } from './recovery-policy.mjs';

const ROUTER_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PREPARED_PROJECT_IDENTITY_FORMAT = 'canonical-devino-v1';

export const DEFAULT_CONFIG_PATH = path.join(ROUTER_ROOT, 'unity-mcp-router.config.json');

export const DEFAULTS = Object.freeze({
  schemaVersion: 2,
  unityBin: 'unity',
  unityArgs: Object.freeze([]),
  minimumCliVersion: '1.0.0-beta.3',
  startupTimeoutSec: 60,
  toolTimeoutSec: 300,
  reauthIntervalMin: 20,
  queue: Object.freeze({
    maxPendingPerClient: 32,
    maxPendingPerProject: 128,
    maxPendingTotal: 512,
    maxHeavyInFlight: 1,
    deadlineSec: 300,
  }),
  recovery: Object.freeze({
    safeReadRetries: 1,
  }),
  license: Object.freeze({ mode: 'single-seat', maxConcurrentEditors: 1 }),
  editorHandoff: Object.freeze({
    mode: 'manual-close',
    pollIntervalMs: 500,
    editorExitTimeoutSec: 180,
    startupTimeoutSec: 900,
  }),
  broker: Object.freeze({ childIdleMin: 15, processAuditEnforcement: 'enforce' }),
});

export class ConfigError extends Error {
  constructor(message, { code = 'INVALID_CONFIG', cause } = {}) {
    super(message, { cause });
    this.name = 'ConfigError';
    this.code = code;
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) {
    throw new ConfigError(`${flag} requires a value`, { code: 'MISSING_ARGUMENT' });
  }
  return value;
}

function numberValue(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${flag} must be a finite number`, { code: 'INVALID_NUMBER' });
  }
  return value;
}

function parseProjectPair(raw, source = '--project') {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new ConfigError(`${source} must be name=/absolute/or/relative/path`, {
      code: 'INVALID_PROJECT',
    });
  }
  return { name: raw.slice(0, eq), path: raw.slice(eq + 1) };
}

export function parseArgv(argv = []) {
  const out = { projects: [], queue: {}, recovery: {}, broker: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--config') out.config = takeValue(argv, index++, flag);
    else if (flag === '--unity') out.unityBin = takeValue(argv, index++, flag);
    else if (flag === '--default') out.defaultProject = takeValue(argv, index++, flag);
    else if (flag === '--broker-socket') out.broker.socketPath = takeValue(argv, index++, flag);
    else if (flag === '--broker-mode') out.brokerMode = takeValue(argv, index++, flag);
    else if (flag === '--project') {
      out.projects.push(parseProjectPair(takeValue(argv, index++, flag)));
    } else if (flag === '--log') out.logFile = takeValue(argv, index++, flag);
    else if (flag === '--tool-timeout-sec') {
      out.toolTimeoutSec = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--startup-timeout-sec') {
      out.startupTimeoutSec = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--reauth-interval-min') {
      out.reauthIntervalMin = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--max-retries' || flag === '--safe-read-retries') {
      out.recovery.safeReadRetries = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--max-pending-per-client') {
      out.queue.maxPendingPerClient = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--max-pending-per-project') {
      out.queue.maxPendingPerProject = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--max-pending-total') {
      out.queue.maxPendingTotal = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--max-heavy-in-flight') {
      out.queue.maxHeavyInFlight = numberValue(takeValue(argv, index++, flag), flag);
    } else if (flag === '--deadline-sec') {
      out.queue.deadlineSec = numberValue(takeValue(argv, index++, flag), flag);
    }
  }
  return out;
}

function asNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asInteger(value, field, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigError(`${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function asFiniteNumber(value, field, { minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new ConfigError(`${field} must be a finite number >= ${minimum}`);
  }
  return value;
}

function normalizeExtraArgs(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${field} must be an array of strings`);
  }
  return [...value];
}

function expandHome(value, homeDir) {
  if (typeof value !== 'string') return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

function inspectManagedPath(
  value,
  field,
  { rejectLeafSymlink = false, cwd = process.cwd() } = {},
) {
  const lexicalPath = path.resolve(cwd, value);
  const missingSegments = [];
  let cursor = lexicalPath;

  for (;;) {
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (cause) {
      if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') {
        const parent = path.dirname(cursor);
        if (parent !== cursor) {
          missingSegments.unshift(path.basename(cursor));
          cursor = parent;
          continue;
        }
      }
      throw new ConfigError(`Cannot safely inspect ${field} at ${lexicalPath}`, {
        code: 'STATE_PATH_UNRESOLVABLE',
        cause,
      });
    }

    if (missingSegments.length === 0 && rejectLeafSymlink && stat.isSymbolicLink()) {
      throw new ConfigError(`${field} must not be an existing symbolic link: ${lexicalPath}`, {
        code: 'STATE_PATH_SYMLINK',
      });
    }

    let canonicalBase;
    let canonicalStat;
    try {
      canonicalBase = realpathSync.native(cursor);
      canonicalStat = statSync(canonicalBase);
    } catch (cause) {
      throw new ConfigError(`Cannot safely resolve ${field} at ${lexicalPath}`, {
        code: 'STATE_PATH_UNRESOLVABLE',
        cause,
      });
    }
    if (missingSegments.length > 0 && !canonicalStat.isDirectory()) {
      throw new ConfigError(
        `${field} cannot be created below non-directory path ${canonicalBase}`,
        { code: 'STATE_PATH_UNRESOLVABLE' },
      );
    }

    return Object.freeze({
      field,
      lexicalPath,
      canonicalPath: missingSegments.length === 0
        ? canonicalBase
        : path.join(canonicalBase, ...missingSegments),
      identity: missingSegments.length === 0
        ? `dev:${String(canonicalStat.dev)}:ino:${String(canonicalStat.ino)}`
        : null,
    });
  }
}

function managedPathsOverlap(left, right) {
  if (left.lexicalPath === right.lexicalPath) return 'lexical path';
  if (left.canonicalPath === right.canonicalPath) return 'canonical path';
  if (left.identity != null && left.identity === right.identity) return 'filesystem identity';
  return null;
}

function validateSocketRuntimeDirectory(socketTarget, { homeDir, cwd }) {
  const runtimeDirectory = inspectManagedPath(
    path.dirname(socketTarget.lexicalPath),
    'broker.socketPath runtime directory',
    { cwd },
  );
  const broadDirectories = [
    ['filesystem root', path.parse(runtimeDirectory.lexicalPath).root],
    ['home directory', homeDir],
    ['shared temporary directory', '/tmp'],
    ['shared temporary directory', '/private/tmp'],
  ];

  for (const [description, directory] of broadDirectories) {
    const broadDirectory = inspectManagedPath(directory, description, { cwd });
    if (managedPathsOverlap(runtimeDirectory, broadDirectory) != null) {
      throw new ConfigError(
        `broker.socketPath runtime directory must be a dedicated subdirectory, not the ${description}: ` +
          runtimeDirectory.lexicalPath,
        { code: 'SOCKET_RUNTIME_DIR_UNSAFE' },
      );
    }
  }
}

function validateManagedStatePaths(targets, { configPath, homeDir, cwd }) {
  const inspected = targets.map(({ field, value }) => inspectManagedPath(value, field, {
    rejectLeafSymlink: true,
    cwd,
  }));

  for (let leftIndex = 0; leftIndex < inspected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inspected.length; rightIndex += 1) {
      const left = inspected[leftIndex];
      const right = inspected[rightIndex];
      const overlap = managedPathsOverlap(left, right);
      if (overlap != null) {
        throw new ConfigError(
          `${left.field} and ${right.field} overlap by ${overlap}: ${left.lexicalPath}`,
          { code: 'STATE_PATH_CONFLICT' },
        );
      }
    }
  }

  if (configPath != null) {
    const configSource = inspectManagedPath(configPath, 'configPath', { cwd });
    for (const target of inspected) {
      const overlap = managedPathsOverlap(target, configSource);
      if (overlap != null) {
        throw new ConfigError(
          `${target.field} overlaps configPath by ${overlap}: ${target.lexicalPath}`,
          { code: 'CONFIG_PATH_CONFLICT' },
        );
      }
    }
  }

  const socketTarget = inspected.find(({ field }) => field === 'broker.socketPath');
  validateSocketRuntimeDirectory(socketTarget, { homeDir, cwd });
}

function profileFingerprint({ unityBin, extraArgs }) {
  return JSON.stringify({ unityBin, extraArgs });
}

export function canonicalizeProject(
  project,
  { cwd = process.cwd(), defaultUnityBin = DEFAULTS.unityBin } = {},
) {
  if (!project || typeof project !== 'object') {
    throw new ConfigError('Each project must be an object');
  }

  const name = asNonEmptyString(project.name, 'project.name');
  const configuredPath = asNonEmptyString(project.path, `project[${name}].path`);
  const resolvedPath = path.resolve(cwd, configuredPath);
  let canonicalPath;
  let stat;
  try {
    canonicalPath = realpathSync.native(resolvedPath);
    stat = statSync(canonicalPath);
  } catch (cause) {
    throw new ConfigError(`Project "${name}" is not reachable at ${resolvedPath}`, {
      code: 'PROJECT_NOT_FOUND',
      cause,
    });
  }
  if (!stat.isDirectory()) {
    throw new ConfigError(`Project "${name}" path is not a directory: ${canonicalPath}`, {
      code: 'PROJECT_NOT_DIRECTORY',
    });
  }

  const unityBin = asNonEmptyString(
    project.unityBin ?? defaultUnityBin,
    `project[${name}].unityBin`,
  );
  const extraArgs = normalizeExtraArgs(project.extraArgs, `project[${name}].extraArgs`);
  const identity = Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
  const key = `dev:${identity.dev}:ino:${identity.ino}`;

  return {
    key,
    name,
    aliases: [name],
    path: canonicalPath,
    identity,
    unityBin,
    extraArgs,
    profileFingerprint: profileFingerprint({ unityBin, extraArgs }),
  };
}

/**
 * Merge aliases that resolve to the same dev/inode. The same physical project
 * may only have one immutable CLI profile; conflicting profiles are rejected
 * instead of creating a second `unity mcp` child.
 */
export function canonicalizeProjects(projects, options = {}) {
  if (!Array.isArray(projects)) {
    throw new ConfigError('projects must be an array');
  }

  const byIdentity = new Map();
  const aliasToKey = new Map();

  for (const input of projects) {
    const project = canonicalizeProject(input, options);
    const priorAliasKey = aliasToKey.get(project.name);
    if (priorAliasKey != null && priorAliasKey !== project.key) {
      throw new ConfigError(
        `Project alias "${project.name}" resolves to more than one checkout`,
        { code: 'ALIAS_CONFLICT' },
      );
    }

    const existing = byIdentity.get(project.key);
    if (existing) {
      if (existing.profileFingerprint !== project.profileFingerprint) {
        throw new ConfigError(
          `Project aliases "${existing.aliases.join(', ')}" and "${project.name}" ` +
            `resolve to ${existing.path} but use different unityBin/extraArgs profiles`,
          { code: 'ADAPTER_PROFILE_CONFLICT' },
        );
      }
      if (!existing.aliases.includes(project.name)) existing.aliases.push(project.name);
    } else {
      byIdentity.set(project.key, project);
    }
    aliasToKey.set(project.name, project.key);
  }

  const canonicalProjects = [...byIdentity.values()].map((project) =>
    Object.freeze({
      ...project,
      aliases: Object.freeze([...project.aliases]),
      extraArgs: Object.freeze([...project.extraArgs]),
    }),
  );
  const aliases = Object.freeze(Object.fromEntries(aliasToKey));
  return Object.freeze({ projects: Object.freeze(canonicalProjects), aliases });
}

function preparedIdentityPart(value, field) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ConfigError(`${field} must be a decimal string`, {
      code: 'PREPARED_PROJECT_IDENTITY_INVALID',
    });
  }
  return value;
}

/**
 * Load installer-prepared canonical project identities without touching the
 * project filesystem. Only audited installed entrypoints opt into this path;
 * source configuration is always canonicalized from the live filesystem.
 */
export function canonicalizePreparedProjects(projects, options = {}) {
  if (!Array.isArray(projects)) {
    throw new ConfigError('projects must be an array');
  }
  const defaultUnityBin = options.defaultUnityBin ?? DEFAULTS.unityBin;
  const byKey = new Map();
  const byPath = new Map();
  const aliasToKey = new Map();

  for (const input of projects) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ConfigError('Each prepared project must be an object', {
        code: 'PREPARED_PROJECT_INVALID',
      });
    }
    const canonicalPath = asNonEmptyString(input.path, 'prepared project.path');
    if (!path.isAbsolute(canonicalPath) || path.normalize(canonicalPath) !== canonicalPath) {
      throw new ConfigError(`Prepared project path must be canonical and absolute: ${canonicalPath}`, {
        code: 'PREPARED_PROJECT_PATH_INVALID',
      });
    }
    if (!Array.isArray(input.aliases) || input.aliases.length === 0) {
      throw new ConfigError('Prepared project.aliases must be a non-empty array', {
        code: 'PREPARED_PROJECT_ALIASES_INVALID',
      });
    }
    const aliases = input.aliases.map((alias, index) =>
      asNonEmptyString(alias, `prepared project.aliases[${index}]`));
    if (new Set(aliases).size !== aliases.length) {
      throw new ConfigError('Prepared project aliases must be unique', {
        code: 'PREPARED_PROJECT_ALIASES_INVALID',
      });
    }
    const dev = preparedIdentityPart(input.identity?.dev, 'prepared project.identity.dev');
    const ino = preparedIdentityPart(input.identity?.ino, 'prepared project.identity.ino');
    const key = `dev:${dev}:ino:${ino}`;
    if (input.key !== key) {
      throw new ConfigError(`Prepared project key does not match its identity: ${String(input.key)}`, {
        code: 'PREPARED_PROJECT_IDENTITY_INVALID',
      });
    }
    if (byKey.has(key) || (byPath.has(canonicalPath) && byPath.get(canonicalPath) !== key)) {
      throw new ConfigError(`Prepared project identity/path is duplicated: ${canonicalPath}`, {
        code: 'PREPARED_PROJECT_DUPLICATE',
      });
    }
    for (const alias of aliases) {
      if (aliasToKey.has(alias)) {
        throw new ConfigError(`Prepared project alias is duplicated: ${alias}`, {
          code: 'ALIAS_CONFLICT',
        });
      }
      aliasToKey.set(alias, key);
    }
    const unityBin = asNonEmptyString(
      input.unityBin ?? defaultUnityBin,
      `project[${aliases[0]}].unityBin`,
    );
    const extraArgs = normalizeExtraArgs(input.extraArgs, `project[${aliases[0]}].extraArgs`);
    const identity = Object.freeze({ dev, ino });
    const project = Object.freeze({
      key,
      name: aliases[0],
      aliases: Object.freeze(aliases),
      path: canonicalPath,
      identity,
      unityBin,
      extraArgs: Object.freeze(extraArgs),
      profileFingerprint: profileFingerprint({ unityBin, extraArgs }),
    });
    byKey.set(key, project);
    byPath.set(canonicalPath, key);
  }

  return Object.freeze({
    projects: Object.freeze([...byKey.values()]),
    aliases: Object.freeze(Object.fromEntries(aliasToKey)),
  });
}

function queueValue(queue, canonicalName, shortName, fallback) {
  return queue?.[canonicalName] ?? queue?.[shortName] ?? fallback;
}

export function normalizeConfig(
  raw = {},
  {
    cwd = process.cwd(),
    homeDir = homedir(),
    configPath,
    allowPreparedProjects = false,
    requirePreparedProjects = false,
  } = {},
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('Config root must be an object');
  }
  const inputVersion = raw.schemaVersion ?? 1;
  if (inputVersion !== 1 && inputVersion !== 2) {
    throw new ConfigError(`Unsupported config schemaVersion: ${inputVersion}`, {
      code: 'UNSUPPORTED_SCHEMA',
    });
  }

  const unityBin = asNonEmptyString(raw.unityBin ?? DEFAULTS.unityBin, 'unityBin');
  const unityArgs = normalizeExtraArgs(raw.unityArgs ?? DEFAULTS.unityArgs, 'unityArgs');
  const minimumCliVersion = asNonEmptyString(
    raw.minimumCliVersion ?? DEFAULTS.minimumCliVersion,
    'minimumCliVersion',
  );
  if (
    requirePreparedProjects
    && raw.projectIdentityFormat !== PREPARED_PROJECT_IDENTITY_FORMAT
  ) {
    throw new ConfigError('Installed runtime requires immutable prepared project identities', {
      code: 'PREPARED_PROJECTS_REQUIRED',
    });
  }
  let canonical;
  if (raw.projectIdentityFormat == null) {
    canonical = canonicalizeProjects(raw.projects ?? [], { cwd, defaultUnityBin: unityBin });
  } else {
    if (raw.projectIdentityFormat !== PREPARED_PROJECT_IDENTITY_FORMAT) {
      throw new ConfigError(`Unsupported projectIdentityFormat: ${raw.projectIdentityFormat}`, {
        code: 'PREPARED_PROJECT_FORMAT_UNSUPPORTED',
      });
    }
    if (!allowPreparedProjects) {
      throw new ConfigError('Prepared project identities are accepted only by audited installed entrypoints', {
        code: 'PREPARED_PROJECTS_NOT_TRUSTED',
      });
    }
    canonical = canonicalizePreparedProjects(raw.projects ?? [], { defaultUnityBin: unityBin });
  }
  const firstAlias = canonical.projects[0]?.aliases[0];
  const defaultProject = raw.defaultProject ?? firstAlias;
  if (defaultProject != null && canonical.aliases[defaultProject] == null) {
    throw new ConfigError(`defaultProject "${defaultProject}" is not a configured alias`, {
      code: 'UNKNOWN_DEFAULT_PROJECT',
    });
  }

  const toolTimeoutSec = asFiniteNumber(
    raw.toolTimeoutSec ?? DEFAULTS.toolTimeoutSec,
    'toolTimeoutSec',
  );
  const queue = raw.queue ?? {};
  const normalizedQueue = Object.freeze({
    maxPendingPerClient: asInteger(
      queueValue(queue, 'maxPendingPerClient', 'maxClient', DEFAULTS.queue.maxPendingPerClient),
      'queue.maxPendingPerClient',
      { minimum: 1 },
    ),
    maxPendingPerProject: asInteger(
      queueValue(queue, 'maxPendingPerProject', 'maxProject', DEFAULTS.queue.maxPendingPerProject),
      'queue.maxPendingPerProject',
      { minimum: 1 },
    ),
    maxPendingTotal: asInteger(
      queueValue(queue, 'maxPendingTotal', 'maxTotal', DEFAULTS.queue.maxPendingTotal),
      'queue.maxPendingTotal',
      { minimum: 1 },
    ),
    maxHeavyInFlight: asInteger(
      queueValue(queue, 'maxHeavyInFlight', 'heavy', DEFAULTS.queue.maxHeavyInFlight),
      'queue.maxHeavyInFlight',
      { minimum: 1 },
    ),
    deadlineSec: asFiniteNumber(
      queueValue(queue, 'deadlineSec', 'deadline', raw.toolTimeoutSec ?? DEFAULTS.queue.deadlineSec),
      'queue.deadlineSec',
      { minimum: 0.001 },
    ),
  });

  const safeReadRetries = asInteger(
    raw.recovery?.safeReadRetries ?? raw.maxRetries ?? DEFAULTS.recovery.safeReadRetries,
    'recovery.safeReadRetries',
  );
  if (safeReadRetries !== 1) {
    throw new ConfigError('recovery.safeReadRetries must be exactly 1');
  }
  const toolClasses = { ...(raw.recovery?.toolClasses ?? {}) };
  try {
    validateToolClassOverrides(toolClasses);
  } catch (error) {
    throw new ConfigError(`recovery.toolClasses: ${error.message}`, {
      code: 'INVALID_TOOL_CLASS_OVERRIDE',
      cause: error,
    });
  }
  const licenseMode = raw.license?.mode ?? DEFAULTS.license.mode;
  if (licenseMode !== 'single-seat' && licenseMode !== 'floating') {
    throw new ConfigError('license.mode must be "single-seat" or "floating"');
  }
  const maxConcurrentEditors = asInteger(
    raw.license?.maxConcurrentEditors ??
      (licenseMode === 'floating' ? 2 : DEFAULTS.license.maxConcurrentEditors),
    'license.maxConcurrentEditors',
    { minimum: 1 },
  );
  if (licenseMode === 'single-seat' && maxConcurrentEditors !== 1) {
    throw new ConfigError('single-seat mode requires license.maxConcurrentEditors = 1');
  }
  if (maxConcurrentEditors > 2) {
    throw new ConfigError('license.maxConcurrentEditors must not exceed 2');
  }
  const editorHandoff = raw.editorHandoff ?? {};
  const editorHandoffMode = Object.prototype.hasOwnProperty.call(editorHandoff, 'mode')
    ? editorHandoff.mode
    : (licenseMode === 'single-seat' ? DEFAULTS.editorHandoff.mode : 'disabled');
  if (!['disabled', 'manual-close', 'typed-auto-close'].includes(editorHandoffMode)) {
    throw new ConfigError(
      'editorHandoff.mode must be "disabled", "manual-close", or "typed-auto-close"',
    );
  }
  if (editorHandoffMode !== 'disabled' &&
      (licenseMode !== 'single-seat' || maxConcurrentEditors !== 1)) {
    throw new ConfigError(
      'Editor handoff requires single-seat mode with license.maxConcurrentEditors = 1',
    );
  }
  const normalizedEditorHandoff = Object.freeze({
    mode: editorHandoffMode,
    pollIntervalMs: asInteger(
      editorHandoff.pollIntervalMs ?? DEFAULTS.editorHandoff.pollIntervalMs,
      'editorHandoff.pollIntervalMs',
      { minimum: 100 },
    ),
    editorExitTimeoutSec: asFiniteNumber(
      editorHandoff.editorExitTimeoutSec ?? DEFAULTS.editorHandoff.editorExitTimeoutSec,
      'editorHandoff.editorExitTimeoutSec',
      { minimum: 10 },
    ),
    startupTimeoutSec: asFiniteNumber(
      editorHandoff.startupTimeoutSec ?? DEFAULTS.editorHandoff.startupTimeoutSec,
      'editorHandoff.startupTimeoutSec',
      { minimum: 30 },
    ),
  });
  const broker = raw.broker ?? {};
  let socketPath = path.resolve(cwd, expandHome(
    broker.socketPath ?? path.join(homeDir, '.unity-mcp-router', 'run', 'broker-v2.sock'),
    homeDir,
  ));
  if (process.platform === 'darwin' && Buffer.byteLength(socketPath) >= 104) {
    if (broker.socketPath != null) {
      throw new ConfigError(
        `broker.socketPath exceeds the macOS AF_UNIX limit (103 bytes): ${socketPath}`,
        { code: 'SOCKET_PATH_TOO_LONG' },
      );
    }
    // A long macOS home/test path can exceed sockaddr_un even when the user did
    // not configure a custom socket. Keep the fallback per-uid and let the
    // daemon enforce 0700 directory + 0600 socket permissions.
    socketPath = `/tmp/unity-mcp-router-${process.getuid?.() ?? 'user'}/broker-v2.sock`;
  }
  const journalFile = path.resolve(cwd, expandHome(
    broker.journalFile ?? path.join(homeDir, '.unity-mcp-router', 'operations.jsonl'),
    homeDir,
  ));
  const workspaceLeaseFile = path.resolve(cwd, expandHome(
    broker.workspaceLeaseFile ?? path.join(homeDir, '.unity-mcp-router', 'workspace-leases.json'),
    homeDir,
  ));
  const adminTokenFile = path.resolve(cwd, expandHome(
    broker.adminTokenFile ?? path.join(homeDir, '.unity-mcp-router', 'admin-token'),
    homeDir,
  ));
  const logFile = path.resolve(cwd, expandHome(
    raw.logFile ?? path.join(homeDir, '.unity-mcp-router', 'broker.log'),
    homeDir,
  ));
  validateManagedStatePaths([
    { field: 'logFile', value: logFile },
    { field: 'broker.journalFile', value: journalFile },
    { field: 'broker.workspaceLeaseFile', value: workspaceLeaseFile },
    { field: 'broker.adminTokenFile', value: adminTokenFile },
    { field: 'broker.socketPath', value: socketPath },
  ], { configPath, homeDir, cwd });
  const processAuditEnforcement = broker.processAuditEnforcement ?? DEFAULTS.broker.processAuditEnforcement;
  if (processAuditEnforcement !== 'enforce' && processAuditEnforcement !== 'report-only') {
    throw new ConfigError('broker.processAuditEnforcement must be "enforce" or "report-only"');
  }

  return Object.freeze({
    schemaVersion: DEFAULTS.schemaVersion,
    sourceSchemaVersion: inputVersion,
    unityBin,
    unityArgs: Object.freeze([...unityArgs]),
    minimumCliVersion,
    defaultProject,
    projects: canonical.projects,
    aliases: canonical.aliases,
    logFile,
    startupTimeoutSec: asFiniteNumber(
      raw.startupTimeoutSec ?? DEFAULTS.startupTimeoutSec,
      'startupTimeoutSec',
    ),
    toolTimeoutSec,
    reauthIntervalMin: asFiniteNumber(
      raw.reauthIntervalMin ?? DEFAULTS.reauthIntervalMin,
      'reauthIntervalMin',
    ),
    queue: normalizedQueue,
    recovery: Object.freeze({
      safeReadRetries,
      toolClasses: Object.freeze(toolClasses),
    }),
    license: Object.freeze({ mode: licenseMode, maxConcurrentEditors }),
    editorHandoff: normalizedEditorHandoff,
    broker: Object.freeze({
      socketPath,
      journalFile,
      workspaceLeaseFile,
      adminTokenFile,
      processAuditEnforcement,
      childIdleMin: asFiniteNumber(
        broker.childIdleMin ?? DEFAULTS.broker.childIdleMin,
        'broker.childIdleMin',
      ),
    }),
    brokerMode: raw.brokerMode ?? 'auto',
  });
}

function parseEnvProjects(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseProjectPair(part, 'UNITY_MCP_PROJECTS'));
}

export function loadConfig({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  homeDir = homedir(),
  defaultConfigPath = DEFAULT_CONFIG_PATH,
  allowPreparedProjects = false,
  requirePreparedProjects = false,
} = {}) {
  const cli = parseArgv(argv);
  const configPath = path.resolve(cwd, cli.config ?? defaultConfigPath);
  let file = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (cause) {
      throw new ConfigError(`Cannot parse config at ${configPath}: ${cause.message}`, {
        code: 'CONFIG_PARSE_FAILED',
        cause,
      });
    }
  }

  const environmentProjects = parseEnvProjects(env.UNITY_MCP_PROJECTS);
  if (file.projectIdentityFormat != null && (environmentProjects.length > 0 || cli.projects.length > 0)) {
    throw new ConfigError('Prepared project identities cannot be extended from environment or CLI flags', {
      code: 'PREPARED_PROJECT_OVERRIDE_FORBIDDEN',
    });
  }
  const raw = {
    ...file,
    unityBin: cli.unityBin ?? env.UNITY_BIN ?? file.unityBin,
    defaultProject: cli.defaultProject ?? env.UNITY_MCP_DEFAULT ?? file.defaultProject,
    projects: [
      ...(file.projects ?? []),
      ...environmentProjects,
      ...cli.projects,
    ],
    logFile: cli.logFile ?? file.logFile,
    toolTimeoutSec: cli.toolTimeoutSec ?? file.toolTimeoutSec,
    startupTimeoutSec: cli.startupTimeoutSec ?? file.startupTimeoutSec,
    reauthIntervalMin: cli.reauthIntervalMin ?? file.reauthIntervalMin,
    queue: { ...(file.queue ?? {}), ...cli.queue },
    recovery: {
      ...(file.recovery ?? {}),
      ...(cli.recovery.safeReadRetries == null
        ? {}
        : { safeReadRetries: cli.recovery.safeReadRetries }),
    },
    broker: { ...(file.broker ?? {}), ...cli.broker },
    brokerMode: cli.brokerMode ?? file.brokerMode,
  };

  const normalized = normalizeConfig(raw, {
    cwd,
    homeDir,
    configPath,
    allowPreparedProjects,
    requirePreparedProjects,
  });
  return Object.freeze({ ...normalized, configPath });
}

export function configFingerprint(config) {
  const stable = {
    schemaVersion: config.schemaVersion,
    unityBin: config.unityBin,
    unityArgs: config.unityArgs,
    minimumCliVersion: config.minimumCliVersion,
    projects: config.projects.map((project) => ({
      key: project.key,
      path: project.path,
      aliases: [...project.aliases].sort(),
      unityBin: project.unityBin,
      extraArgs: project.extraArgs,
    })).sort((left, right) => left.key.localeCompare(right.key)),
    queue: config.queue,
    recovery: config.recovery,
    license: config.license,
    editorHandoff: config.editorHandoff,
    broker: config.broker,
    startupTimeoutSec: config.startupTimeoutSec,
    toolTimeoutSec: config.toolTimeoutSec,
    reauthIntervalMin: config.reauthIntervalMin,
    logFile: config.logFile,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function projectForAlias(config, alias = config?.defaultProject) {
  const key = config?.aliases?.[alias];
  return key == null ? undefined : config.projects.find((project) => project.key === key);
}
