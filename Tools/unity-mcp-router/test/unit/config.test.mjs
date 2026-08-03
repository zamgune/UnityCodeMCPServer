import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  DEFAULTS,
  canonicalizeProjects,
  loadConfig,
  normalizeConfig,
  parseArgv,
  projectForAlias,
} from '../../lib/config.mjs';

const ROUTER_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'unity-router-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectA = path.join(root, 'ProjectA');
  const projectB = path.join(root, 'ProjectB');
  mkdirSync(projectA);
  mkdirSync(projectB);
  return { root, projectA, projectB };
}

function throwsConfigCode(code) {
  return (error) => error instanceof ConfigError && error.code === code;
}

test('v1 config is accepted and receives all v2 defaults', (t) => {
  const { root, projectA } = fixture(t);
  const config = normalizeConfig(
    {
      unityBin: '/opt/unity-cli',
      defaultProject: 'A',
      projects: [{ name: 'A', path: projectA }],
      maxRetries: 1,
    },
    { cwd: root, homeDir: root },
  );

  assert.equal(config.sourceSchemaVersion, 1);
  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.queue, DEFAULTS.queue);
  assert.equal(config.recovery.safeReadRetries, 1);
  assert.equal(config.defaultProject, 'A');
  assert.equal(projectForAlias(config, 'A').path, realpathSync.native(projectA));
});

test('v2 short and canonical queue keys normalize to public names', (t) => {
  const { root, projectA } = fixture(t);
  const config = normalizeConfig(
    {
      schemaVersion: 2,
      projects: [{ name: 'A', path: projectA }],
      queue: {
        maxClient: 4,
        maxPendingPerProject: 9,
        maxTotal: 12,
        heavy: 2,
        deadline: 45,
      },
      recovery: { safeReadRetries: 1 },
    },
    { cwd: root },
  );
  assert.deepEqual(config.queue, {
    maxPendingPerClient: 4,
    maxPendingPerProject: 9,
    maxPendingTotal: 12,
    maxHeavyInFlight: 2,
    deadlineSec: 45,
  });
  assert.equal(config.recovery.safeReadRetries, 1);
});

test('safe-read retry and Editor seat limits are fail-closed invariants', (t) => {
  const { root, projectA } = fixture(t);
  const base = { projects: [{ name: 'A', path: projectA }] };

  for (const safeReadRetries of [0, 2, 99]) {
    assert.throws(
      () => normalizeConfig({ ...base, recovery: { safeReadRetries } }, { cwd: root }),
      /safeReadRetries must be exactly 1/,
    );
  }
  assert.throws(
    () => normalizeConfig({
      ...base,
      license: { mode: 'floating', maxConcurrentEditors: 3 },
    }, { cwd: root }),
    /maxConcurrentEditors must not exceed 2/,
  );
  assert.equal(normalizeConfig({
    ...base,
    license: { mode: 'floating', maxConcurrentEditors: 2 },
  }, { cwd: root }).license.maxConcurrentEditors, 2);
});

test('config rejects built-in tool class overrides and permits custom exact names', (t) => {
  const { root, projectA } = fixture(t);
  const base = { projects: [{ name: 'A', path: projectA }] };

  assert.throws(
    () => normalizeConfig({
      ...base,
      recovery: {
        safeReadRetries: 1,
        toolClasses: { eval: 'safe_read' },
      },
    }, { cwd: root }),
    throwsConfigCode('INVALID_TOOL_CLASS_OVERRIDE'),
  );

  const config = normalizeConfig({
    ...base,
    recovery: {
      safeReadRetries: 1,
      toolClasses: { project_health: 'safe_read' },
    },
  }, { cwd: root });
  assert.deepEqual(config.recovery.toolClasses, { project_health: 'safe_read' });
});

test('realpath plus dev/inode merges symlink aliases into one adapter identity', (t) => {
  const { root, projectA } = fixture(t);
  const symlink = path.join(root, 'ProjectAlias');
  symlinkSync(projectA, symlink, 'dir');
  const canonical = canonicalizeProjects(
    [
      { name: 'A', path: projectA, extraArgs: ['--one'] },
      { name: 'AliasA', path: symlink, extraArgs: ['--one'] },
      { name: 'A', path: projectA, extraArgs: ['--one'] },
    ],
    { cwd: root, defaultUnityBin: '/opt/unity' },
  );

  assert.equal(canonical.projects.length, 1);
  assert.deepEqual(canonical.projects[0].aliases, ['A', 'AliasA']);
  assert.equal(canonical.aliases.A, canonical.aliases.AliasA);
  assert.equal(canonical.projects[0].identity.dev.length > 0, true);
  assert.equal(canonical.projects[0].identity.ino.length > 0, true);
});

test('prepare-config stores one canonical project row for all aliases', (t) => {
  const { root, projectA } = fixture(t);
  const aliasPath = path.join(root, 'ProjectAlias');
  const input = path.join(root, 'router.json');
  const output = path.join(root, 'prepared.json');
  const state = path.join(root, 'state');
  symlinkSync(projectA, aliasPath, 'dir');
  writeFileSync(input, JSON.stringify({
    schemaVersion: 2,
    defaultProject: 'AliasA',
    projects: [
      { name: 'A', path: projectA, extraArgs: ['--profile'] },
      { name: 'AliasA', path: aliasPath, extraArgs: ['--profile'] },
    ],
    logFile: path.join(state, 'broker.log'),
    broker: {
      socketPath: path.join(state, 'run', 'broker.sock'),
      journalFile: path.join(state, 'operations.jsonl'),
      workspaceLeaseFile: path.join(state, 'workspace-leases.json'),
      adminTokenFile: path.join(state, 'admin-token'),
    },
  }));

  execFileSync(process.execPath, [
    path.join(ROUTER_ROOT, 'scripts', 'prepare-config.mjs'),
    'prepare',
    '--runtime-root', ROUTER_ROOT,
    '--input', input,
    '--output', output,
  ]);
  const prepared = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(prepared.projectIdentityFormat, 'canonical-devino-v1');
  assert.equal(prepared.projects.length, 1);
  assert.deepEqual(prepared.projects[0].aliases, ['A', 'AliasA']);
  assert.equal(prepared.projects[0].path, realpathSync.native(projectA));
  assert.equal(prepared.defaultProject, 'AliasA');
});

test('audited prepared project identities load without touching an unreachable project path', (t) => {
  const { root } = fixture(t);
  const raw = {
    schemaVersion: 2,
    projectIdentityFormat: 'canonical-devino-v1',
    defaultProject: 'A-alias',
    projects: [{
      key: 'dev:123:ino:456',
      aliases: ['A', 'A-alias'],
      path: '/Volumes/Definitely-Unmounted/ProjectA',
      identity: { dev: '123', ino: '456' },
      unityBin: '/opt/unity',
      extraArgs: [],
    }],
  };
  assert.throws(
    () => normalizeConfig(raw, { homeDir: root }),
    throwsConfigCode('PREPARED_PROJECTS_NOT_TRUSTED'),
  );
  assert.throws(
    () => normalizeConfig({ projects: [] }, {
      homeDir: root,
      allowPreparedProjects: true,
      requirePreparedProjects: true,
    }),
    throwsConfigCode('PREPARED_PROJECTS_REQUIRED'),
  );
  const config = normalizeConfig(raw, {
    homeDir: root,
    allowPreparedProjects: true,
    requirePreparedProjects: true,
  });
  assert.equal(config.projects[0].path, '/Volumes/Definitely-Unmounted/ProjectA');
  assert.equal(config.projects[0].key, 'dev:123:ino:456');
  assert.equal(projectForAlias(config, 'A-alias'), config.projects[0]);
});

test('prepared identities reject key drift, duplicate aliases, and runtime project overrides', (t) => {
  const { root } = fixture(t);
  const project = {
    key: 'dev:1:ino:2', aliases: ['A'], path: '/Volumes/A',
    identity: { dev: '1', ino: '2' }, unityBin: '/opt/unity', extraArgs: [],
  };
  assert.throws(
    () => normalizeConfig({
      schemaVersion: 2,
      projectIdentityFormat: 'canonical-devino-v1',
      projects: [{ ...project, key: 'dev:1:ino:999' }],
    }, { homeDir: root, allowPreparedProjects: true }),
    throwsConfigCode('PREPARED_PROJECT_IDENTITY_INVALID'),
  );
  assert.throws(
    () => normalizeConfig({
      schemaVersion: 2,
      projectIdentityFormat: 'canonical-devino-v1',
      projects: [project, {
        key: 'dev:3:ino:4', aliases: ['A'], path: '/Volumes/B',
        identity: { dev: '3', ino: '4' }, unityBin: '/opt/unity', extraArgs: [],
      }],
    }, { homeDir: root, allowPreparedProjects: true }),
    throwsConfigCode('ALIAS_CONFLICT'),
  );

  const configPath = path.join(root, 'prepared.json');
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2,
    projectIdentityFormat: 'canonical-devino-v1',
    projects: [project],
  }));
  assert.throws(
    () => loadConfig({
      argv: ['--config', configPath, '--project', 'B=/Volumes/B'],
      env: {},
      homeDir: root,
      allowPreparedProjects: true,
    }),
    throwsConfigCode('PREPARED_PROJECT_OVERRIDE_FORBIDDEN'),
  );
});

test('same physical project with different adapter profiles is rejected', (t) => {
  const { root, projectA } = fixture(t);
  assert.throws(
    () =>
      canonicalizeProjects(
        [
          { name: 'A', path: projectA, extraArgs: ['--profile-a'] },
          { name: 'AliasA', path: projectA, extraArgs: ['--profile-b'] },
        ],
        { cwd: root, defaultUnityBin: '/opt/unity' },
      ),
    (error) => error instanceof ConfigError && error.code === 'ADAPTER_PROFILE_CONFLICT',
  );
});

test('same alias resolving to different checkouts is rejected', (t) => {
  const { root, projectA, projectB } = fixture(t);
  assert.throws(
    () =>
      canonicalizeProjects(
        [
          { name: 'Game', path: projectA },
          { name: 'Game', path: projectB },
        ],
        { cwd: root },
      ),
    (error) => error instanceof ConfigError && error.code === 'ALIAS_CONFLICT',
  );
});

test('loadConfig preserves v1 file/env/CLI inputs and CLI limit overrides', (t) => {
  const { root, projectA, projectB } = fixture(t);
  const configPath = path.join(root, 'router.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      unityBin: '/file/unity',
      defaultProject: 'A',
      projects: [{ name: 'A', path: projectA }],
      maxRetries: 8,
    }),
  );

  const config = loadConfig({
    argv: [
      '--config',
      configPath,
      '--default',
      'B',
      '--max-pending-per-client',
      '7',
      '--safe-read-retries',
      '1',
    ],
    env: {
      UNITY_BIN: '/env/unity',
      UNITY_MCP_PROJECTS: `B=${projectB}`,
    },
    cwd: root,
    homeDir: root,
  });

  assert.equal(config.unityBin, '/env/unity');
  assert.equal(config.defaultProject, 'B');
  assert.equal(config.projects.length, 2);
  assert.equal(config.queue.maxPendingPerClient, 7);
  assert.equal(config.recovery.safeReadRetries, 1);
});

test('parseArgv maps deprecated max-retries to safe read retries only', () => {
  const parsed = parseArgv(['--max-retries', '3', '--deadline-sec', '12']);
  assert.equal(parsed.recovery.safeReadRetries, 3);
  assert.equal(parsed.queue.deadlineSec, 12);
  assert.equal('maxRetries' in parsed, false);
});

test('expands explicit home-relative state paths', (t) => {
  const { root, projectA } = fixture(t);
  const config = normalizeConfig({
    projects: [{ name: 'p', path: projectA }],
    logFile: '~/.router/custom.log',
    broker: {
      socketPath: '~/.router/run/router.sock',
      journalFile: '~/.router/ops.jsonl',
    },
  }, { homeDir: root });
  assert.equal(config.logFile, path.join(root, '.router/custom.log'));
  assert.equal(config.broker.socketPath, path.join(root, '.router/run/router.sock'));
  assert.equal(config.broker.journalFile, path.join(root, '.router/ops.jsonl'));
});

test('rejects lexically equivalent managed state targets', (t) => {
  const { root } = fixture(t);
  const stateDirectory = path.join(root, 'state');

  assert.throws(
    () => normalizeConfig({
      logFile: path.join(stateDirectory, 'shared'),
      broker: {
        journalFile: path.join(stateDirectory, 'nested', '..', 'shared'),
      },
    }, { homeDir: root }),
    throwsConfigCode('STATE_PATH_CONFLICT'),
  );
});

test('rejects managed state targets that alias through a symlinked parent', (t) => {
  const { root } = fixture(t);
  const realStateDirectory = path.join(root, 'real-state');
  const stateDirectoryAlias = path.join(root, 'state-alias');
  mkdirSync(realStateDirectory);
  symlinkSync(realStateDirectory, stateDirectoryAlias, 'dir');

  assert.throws(
    () => normalizeConfig({
      logFile: path.join(realStateDirectory, 'shared'),
      broker: {
        journalFile: path.join(stateDirectoryAlias, 'shared'),
      },
    }, { homeDir: root }),
    throwsConfigCode('STATE_PATH_CONFLICT'),
  );
});

test('rejects managed state targets that are existing hard-link aliases', (t) => {
  const { root } = fixture(t);
  const logFile = path.join(root, 'broker.log');
  const journalFile = path.join(root, 'operations.jsonl');
  writeFileSync(logFile, 'state');
  linkSync(logFile, journalFile);

  assert.throws(
    () => normalizeConfig({
      logFile,
      broker: { journalFile },
    }, { homeDir: root }),
    throwsConfigCode('STATE_PATH_CONFLICT'),
  );
});

test('rejects an existing symbolic-link leaf for every managed state target', (t) => {
  const { root } = fixture(t);
  const target = path.join(root, 'actual-state');
  const symlink = path.join(root, 'state-link');
  writeFileSync(target, 'state');
  symlinkSync(target, symlink, 'file');

  const cases = [
    { logFile: symlink },
    { broker: { journalFile: symlink } },
    { broker: { workspaceLeaseFile: symlink } },
    { broker: { adminTokenFile: symlink } },
    { broker: { socketPath: symlink } },
  ];
  for (const raw of cases) {
    assert.throws(
      () => normalizeConfig(raw, { homeDir: root }),
      throwsConfigCode('STATE_PATH_SYMLINK'),
    );
  }
});

test('loadConfig rejects a managed state target that overlaps its config source', (t) => {
  const { root, projectA } = fixture(t);
  const configPath = path.join(root, 'router.json');
  writeFileSync(configPath, JSON.stringify({
    projects: [{ name: 'A', path: projectA }],
    logFile: 'router.json',
  }));

  assert.throws(
    () => loadConfig({
      argv: ['--config', configPath],
      env: {},
      cwd: root,
      homeDir: root,
    }),
    throwsConfigCode('CONFIG_PATH_CONFLICT'),
  );
});

test('loadConfig detects config overlap through existing filesystem identity', (t) => {
  const { root, projectA } = fixture(t);
  const configPath = path.join(root, 'router.json');
  const journalFile = path.join(root, 'operations.jsonl');
  writeFileSync(configPath, JSON.stringify({
    projects: [{ name: 'A', path: projectA }],
    broker: { journalFile },
  }));
  linkSync(configPath, journalFile);

  assert.throws(
    () => loadConfig({
      argv: ['--config', configPath],
      env: {},
      cwd: root,
      homeDir: root,
    }),
    throwsConfigCode('CONFIG_PATH_CONFLICT'),
  );
});

test('rejects broad socket runtime directories but permits dedicated subdirectories', (t) => {
  const { root } = fixture(t);
  const socketName = 'b.sock';
  const broadDirectories = ['/', root, '/tmp', '/private/tmp'];

  for (const directory of broadDirectories) {
    assert.throws(
      () => normalizeConfig({
        broker: { socketPath: path.join(directory, socketName) },
      }, { homeDir: root }),
      throwsConfigCode('SOCKET_RUNTIME_DIR_UNSAFE'),
    );
  }

  const dedicatedDirectory = path.join('/tmp', `unity-router-config-${process.pid}`);
  const config = normalizeConfig({
    broker: { socketPath: path.join(dedicatedDirectory, socketName) },
  }, { homeDir: root });
  assert.equal(config.broker.socketPath, path.join(dedicatedDirectory, socketName));
});

test('rejects a socket runtime directory that resolves to a broad directory', (t) => {
  const { root } = fixture(t);
  const homeAlias = path.join(root, 'home-alias');
  symlinkSync(root, homeAlias, 'dir');

  assert.throws(
    () => normalizeConfig({
      broker: { socketPath: path.join(homeAlias, 'broker.sock') },
    }, { homeDir: root }),
    throwsConfigCode('SOCKET_RUNTIME_DIR_UNSAFE'),
  );
});

test('keeps the per-user macOS socket fallback for a long default home path', {
  skip: process.platform !== 'darwin',
}, (t) => {
  const { root } = fixture(t);
  const longHome = path.join(root, 'h'.repeat(160));
  const config = normalizeConfig({}, { homeDir: longHome });

  assert.equal(
    config.broker.socketPath,
    `/tmp/unity-mcp-router-${process.getuid?.() ?? 'user'}/broker-v2.sock`,
  );
});
