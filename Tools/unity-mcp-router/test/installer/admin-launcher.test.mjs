import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
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

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ADMIN_LAUNCHER = path.join(ROOT, 'scripts', 'admin-launcher.sh');
const OPERATION_ID = '123e4567-e89b-12d3-a456-426614174000';

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'unity-admin-launcher-')));
  const prefix = path.join(root, 'router');
  const runtimes = path.join(prefix, 'runtimes');
  mkdirSync(runtimes, { recursive: true, mode: 0o700 });
  chmodSync(runtimes, 0o700);

  const nodeSource = path.join(root, 'fixture-node');
  writeFileSync(nodeSource, [
    '#!/bin/sh',
    'set -eu',
    'printf "%s\\t%s\\n" "$0" "$1" >> "$ADMIN_NODE_CAPTURE"',
    'exec "$ADMIN_HOST_NODE" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  const nodeSha = sha256(nodeSource);
  const runtime = path.join(runtimes, nodeSha);
  const node = path.join(runtime, 'node');
  mkdirSync(runtime, { mode: 0o700 });
  cpSync(nodeSource, node);
  chmodSync(node, 0o500);
  chmodSync(runtime, 0o500);

  const deploymentId = 'd-a1234567890abcdef';
  const deployment = path.join(prefix, 'deployments', deploymentId);
  const releaseId = '2.0.0-fixture';
  const release = path.join(prefix, 'releases', releaseId);
  mkdirSync(deployment, { recursive: true, mode: 0o700 });
  mkdirSync(release, { recursive: true, mode: 0o700 });
  cpSync(ADMIN_LAUNCHER, path.join(deployment, 'admin-launcher.sh'));
  chmodSync(path.join(deployment, 'admin-launcher.sh'), 0o500);
  writeFileSync(path.join(deployment, 'node-sha256.txt'), `${nodeSha}\n`);
  writeFileSync(path.join(deployment, 'node-bin.txt'), `${node}\n`);
  writeFileSync(path.join(deployment, 'release-id.txt'), `${releaseId}\n`);
  writeFileSync(path.join(deployment, 'label.txt'), 'com.example.fixture\n');
  writeFileSync(path.join(deployment, 'config.json'), '{}\n');

  const auditCapture = path.join(root, 'audit.jsonl');
  const adminCapture = path.join(root, 'admin.jsonl');
  const nodeCapture = path.join(root, 'node.tsv');
  writeFileSync(path.join(deployment, 'deployment-audit.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    'appendFileSync(process.env.ADMIN_AUDIT_CAPTURE, `${JSON.stringify({ argv: process.argv.slice(2) })}\\n`);',
    '',
  ].join('\n'));
  writeFileSync(path.join(deployment, 'broker-admin.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    'appendFileSync(process.env.ADMIN_FORWARD_CAPTURE, `${JSON.stringify({',
    '  argv: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '  execPath: process.execPath,',
    '  preparedConfig: process.env.UNITY_MCP_REQUIRE_PREPARED_CONFIG,',
    '})}\\n`);',
    "process.stdout.write('{\"ok\":true}\\n');",
    '',
  ].join('\n'));

  symlinkSync(`deployments/${deploymentId}`, path.join(prefix, 'current'));
  const bin = path.join(prefix, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const stableAdmin = path.join(bin, 'unity-mcp-router-admin');
  writeFileSync(stableAdmin, [
    '#!/bin/sh',
    'set -eu',
    'case "$0" in */*) SELF_PARENT=${0%/*} ;; *) SELF_PARENT=. ;; esac',
    'SELF_DIR=$(CDPATH= cd -- "$SELF_PARENT" && pwd -P)',
    'PREFIX=${SELF_DIR%/*}',
    'exec /bin/sh "$PREFIX/current/admin-launcher.sh" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });

  t.after(() => {
    chmodSync(runtime, 0o700);
    chmodSync(node, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  const run = (argv) => spawnSync(stableAdmin, argv, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADMIN_AUDIT_CAPTURE: auditCapture,
      ADMIN_FORWARD_CAPTURE: adminCapture,
      ADMIN_NODE_CAPTURE: nodeCapture,
      ADMIN_HOST_NODE: process.execPath,
    },
  });
  return {
    prefix,
    deployment,
    deploymentId,
    release,
    node,
    stableAdmin,
    auditCapture,
    adminCapture,
    nodeCapture,
    run,
  };
}

test('stable admin operation grammar forwards exact immutable deployment arguments without a current/release path', (t) => {
  const f = fixture(t);
  const accepted = [
    {
      argv: ['operation', 'status', OPERATION_ID],
      forwarded: [
        'operation', 'status', OPERATION_ID,
        '--runtime-root', f.release, '--config', path.join(f.deployment, 'config.json'),
      ],
    },
    {
      argv: ['operation', 'resolve', OPERATION_ID, 'confirmed_completed'],
      forwarded: [
        'operation', 'resolve', OPERATION_ID, 'confirmed_completed',
        '--runtime-root', f.release, '--config', path.join(f.deployment, 'config.json'),
      ],
    },
    {
      argv: [
        'operation', 'resolve', OPERATION_ID, 'confirmed_completed',
        '--confirm-no-longer-running',
      ],
      forwarded: [
        'operation', 'resolve', OPERATION_ID, 'confirmed_completed',
        '--confirm-no-longer-running',
        '--runtime-root', f.release, '--config', path.join(f.deployment, 'config.json'),
      ],
    },
  ];

  for (const entry of accepted) {
    const result = f.run(entry.argv);
    assert.equal(result.status, 0, `${entry.argv.join(' ')}\n${result.stderr}\n${result.stdout}`);
  }

  const forwarded = readJsonLines(f.adminCapture);
  assert.deepEqual(forwarded.map((entry) => entry.argv), accepted.map((entry) => entry.forwarded));
  for (const entry of forwarded) {
    assert.equal(entry.cwd, f.release);
    assert.equal(entry.execPath, process.execPath);
    assert.equal(entry.preparedConfig, '1');
  }
  const nodeInvocations = readFileSync(f.nodeCapture, 'utf8').trim().split('\n').map((line) => line.split('\t'));
  assert.equal(nodeInvocations.length, accepted.length * 2);
  for (const [index, invocation] of nodeInvocations.entries()) {
    assert.equal(invocation[0], f.node);
    assert.equal(invocation[1], path.join(f.deployment, index % 2 === 0 ? 'deployment-audit.mjs' : 'broker-admin.mjs'));
  }
  const audits = readJsonLines(f.auditCapture);
  assert.equal(audits.length, accepted.length);
  for (const audit of audits) {
    assert.deepEqual(audit.argv, [
      '--prefix', f.prefix,
      '--target', `deployments/${f.deploymentId}`,
      '--expected-label', 'com.example.fixture',
    ]);
  }
  assert.equal(realpathSync(path.join(f.prefix, 'current')), f.deployment);
  assert.equal(existsSync(path.join(f.prefix, 'current', 'release')), false);

  const rejected = [
    ['call', 'unity_router_operation_status', '{}'],
    ['restart', 'fixture'],
    ['workspace', 'resolve', 'lease-token', '--confirm'],
    ['operation'],
    ['operation', 'status'],
    ['operation', 'status', 'op-1'],
    ['operation', 'status', '123e4567-e89b-12d3-a456-42661417400g'],
    ['operation', 'status', '123e4567e89b12d3a456426614174000'],
    ['operation', 'status', `${OPERATION_ID}0`],
    ['operation', 'status', OPERATION_ID, '--timeout-sec', '5'],
    ['operation', 'status', OPERATION_ID, '--config', '/tmp/other.json'],
    ['operation', 'resolve', OPERATION_ID, 'safe_to_retry'],
    ['operation', 'resolve', OPERATION_ID, 'abandoned'],
    ['operation', 'resolve', OPERATION_ID, 'confirmed_completed', '--timeout-sec', '5'],
    ['operation', 'resolve', OPERATION_ID, '--confirm-no-longer-running', 'confirmed_completed'],
    [
      'operation', 'resolve', OPERATION_ID, 'confirmed_completed',
      '--confirm-no-longer-running', '--confirm-no-longer-running',
    ],
  ];
  for (const argv of rejected) {
    const result = f.run(argv);
    assert.equal(result.status, 64, `${argv.join(' ')}\n${result.stderr}\n${result.stdout}`);
  }
  assert.equal(readJsonLines(f.adminCapture).length, accepted.length);
  assert.equal(readJsonLines(f.auditCapture).length, accepted.length);
});
