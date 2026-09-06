import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  classifyProjectAccessError,
  ProjectAccessAuditor,
  ProjectAccessError,
} from '../../lib/project-access-audit.mjs';

function unityProject(t, name = 'Project With Spaces') {
  const root = mkdtempSync('/tmp/upaccess-');
  const projectPath = path.join(root, name);
  mkdirSync(path.join(projectPath, 'Assets'), { recursive: true });
  mkdirSync(path.join(projectPath, 'ProjectSettings'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return projectDescriptor(projectPath, name);
}

function projectDescriptor(projectPath, name, identity = null) {
  const resolvedIdentity = identity ?? (() => {
    const stat = statSync(projectPath);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  })();
  return {
    name,
    key: `dev:${resolvedIdentity.dev}:ino:${resolvedIdentity.ino}`,
    path: projectPath,
    identity: resolvedIdentity,
  };
}

function fakeProbe(t, body) {
  const root = mkdtempSync('/tmp/upaccess-probe-');
  const probeFile = path.join(root, 'probe.mjs');
  writeFileSync(probeFile, body);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return probeFile;
}

test('audits a Unity project with an argv-safe path and caches the successful result', async (t) => {
  const project = unityProject(t);
  const auditor = new ProjectAccessAuditor({ projects: [project] });
  t.after(() => auditor.close());

  const first = await auditor.assertAccessible(project);
  const second = await auditor.audit(project);
  assert.equal(first.ok, true);
  assert.equal(first.code, 'PROJECT_ACCESS_OK');
  assert.equal(first.projectPath, project.path);
  assert.equal(first.projectKey, project.key);
  assert.deepEqual(first.expectedIdentity, project.identity);
  assert.deepEqual(first.observedIdentity, project.identity);
  assert.strictEqual(second, first);
  assert.equal(auditor.snapshot().projects[0].stale, false);
});

test('rejects a same-path replacement whose physical project identity changed', async (t) => {
  const project = unityProject(t, 'Replace Me');
  const displacedPath = `${project.path}.original`;
  renameSync(project.path, displacedPath);
  mkdirSync(path.join(project.path, 'Assets'), { recursive: true });
  mkdirSync(path.join(project.path, 'ProjectSettings'));

  const observed = statSync(project.path);
  assert.notEqual(
    `dev:${observed.dev}:ino:${observed.ino}`,
    project.key,
    'test setup must replace the directory identity',
  );

  const auditor = new ProjectAccessAuditor({ projects: [project] });
  t.after(() => auditor.close());
  const result = await auditor.audit(project, { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_IDENTITY_MISMATCH');
  assert.equal(result.projectKey, project.key);
  assert.deepEqual(result.expectedIdentity, project.identity);
  assert.deepEqual(result.observedIdentity, {
    dev: String(observed.dev),
    ino: String(observed.ino),
  });
  assert.equal(result.likelyCause, 'PROJECT_PATH_REPLACED_OR_REMOUNTED');
});

test('classifies missing, denied, and unavailable project access distinctly', async (t) => {
  const missing = path.join(mkdtempSync('/tmp/upaccess-missing-'), 'absent');
  t.after(() => rmSync(path.dirname(missing), { recursive: true, force: true }));
  const auditor = new ProjectAccessAuditor();
  t.after(() => auditor.close());
  const missingProject = projectDescriptor(missing, 'missing', { dev: '999', ino: '999' });

  const missingResult = await auditor.audit(missingProject);
  assert.equal(missingResult.code, 'PROJECT_NOT_UNITY_PROJECT');
  await assert.rejects(
    () => auditor.assertAccessible(missingProject, { force: true }),
    (error) => error instanceof ProjectAccessError && error.code === 'PROJECT_NOT_UNITY_PROJECT',
  );

  const denied = classifyProjectAccessError({ code: 'EPERM', syscall: 'stat', path: '/Volumes/Test/Assets' }, '/Volumes/Test');
  assert.equal(denied.code, 'PROJECT_ACCESS_DENIED');
  assert.equal(denied.likelyCause, 'REMOVABLE_VOLUME_PRIVACY_DENIED');
  const unavailable = classifyProjectAccessError({ code: 'EIO' }, '/Volumes/Test');
  assert.equal(unavailable.code, 'PROJECT_VOLUME_UNAVAILABLE');
});

test('kills a hanging probe within the bounded timeout and reports the responsible executable', async (t) => {
  const project = unityProject(t, 'Hang');
  const probeFile = fakeProbe(t, 'setInterval(() => {}, 1000);\n');
  const auditor = new ProjectAccessAuditor({ probeFile, timeoutMs: 80 });
  t.after(() => auditor.close());
  const started = Date.now();
  const result = await auditor.audit(project, { force: true });
  assert.equal(result.code, 'PROJECT_ACCESS_PROBE_TIMEOUT');
  assert.equal(result.responsibleExecutable, process.execPath);
  assert(Date.now() - started < 1_000);
});

test('rejects malformed and oversized probe output without trusting it', async (t) => {
  const project = unityProject(t, 'Malformed');
  const malformedFile = fakeProbe(t, 'process.stdout.write("not-json\\n");\n');
  const malformed = new ProjectAccessAuditor({ probeFile: malformedFile, timeoutMs: 500 });
  t.after(() => malformed.close());
  assert.equal(
    (await malformed.audit(project, { force: true })).code,
    'PROJECT_ACCESS_PROBE_INVALID',
  );

  const oversizedFile = fakeProbe(t, 'process.stdout.write("x".repeat(4096));\n');
  const oversized = new ProjectAccessAuditor({
    probeFile: oversizedFile,
    timeoutMs: 500,
    maxOutputBytes: 128,
  });
  t.after(() => oversized.close());
  const result = await oversized.audit(project, { force: true });
  assert.equal(result.code, 'PROJECT_ACCESS_PROBE_INVALID');
  assert.equal(result.likelyCause, 'PROBE_OUTPUT_LIMIT_EXCEEDED');
});

test('shares one fixed-time probe without letting a short caller deadline poison a longer caller', async (t) => {
  const project = unityProject(t, 'Dedupe With Spaces');
  const root = mkdtempSync('/tmp/upaccess-count-');
  const calls = path.join(root, 'calls.txt');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probeFile = fakeProbe(t, `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.PROBE_CALLS, 'call\\n');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const projectPath = process.argv[3];
    const projectKey = process.argv[4];
    const expectedIdentity = { dev: process.argv[5], ino: process.argv[6] };
    process.stdout.write(JSON.stringify({
      schemaVersion: 2, ok: true, code: 'PROJECT_ACCESS_OK', projectPath, projectKey,
      expectedIdentity, observedIdentity: expectedIdentity,
      checkedAt: new Date().toISOString(), likelyCause: null, remediation: null, details: {},
    }) + '\\n');
  `);
  const auditor = new ProjectAccessAuditor({
    probeFile,
    timeoutMs: 800,
    env: { ...process.env, PROBE_CALLS: calls },
  });
  t.after(() => auditor.close());
  const started = Date.now();
  const [longCaller, shortCaller] = await Promise.all([
    auditor.audit(project, { force: true, deadlineAt: started + 700 }),
    auditor.audit(project, { force: true, deadlineAt: started + 35 }),
  ]);
  assert.equal(shortCaller.code, 'DEADLINE_EXCEEDED');
  assert.equal(shortCaller.likelyCause, 'CALLER_DEADLINE_EXPIRED');
  assert.equal(longCaller.ok, true);
  assert.equal(longCaller.code, 'PROJECT_ACCESS_OK');
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  assert.strictEqual(await auditor.audit(project), longCaller);
});

test('keeps a timed-out probe quarantined and applies the global active-probe cap until reap', async (t) => {
  const firstProject = unityProject(t, 'Stalled One');
  const secondProject = unityProject(t, 'Stalled Two');
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    children.push(child);
    return child;
  };
  const auditor = new ProjectAccessAuditor({
    spawnProcess,
    timeoutMs: 30,
    maxActiveProbes: 1,
  });
  t.after(async () => {
    for (const child of children) child.emit('close', null, 'SIGKILL');
    await auditor.close();
  });

  const timedOut = await auditor.audit(firstProject, { force: true });
  assert.equal(timedOut.code, 'PROJECT_ACCESS_PROBE_TIMEOUT');
  assert.equal(children.length, 1);

  const quarantined = await auditor.audit(firstProject, { force: true });
  assert.equal(quarantined.code, 'PROJECT_ACCESS_PROBE_TIMEOUT');
  assert.equal(children.length, 1, 'same-project retry must not spawn while its child is terminating');

  const capped = await auditor.audit(secondProject, { force: true });
  assert.equal(capped.code, 'PROJECT_ACCESS_PROBE_CAPACITY');
  assert.deepEqual(capped.details, { activeProbes: 1, maxActiveProbes: 1 });
  assert.equal(children.length, 1, 'global cap must reject before spawning another child');

  children[0].emit('close', null, 'SIGKILL');
  assert.equal(auditor.snapshot().activeProbes, 0);
});


test('audits fourteen configured projects without exceeding the eight-probe limit', async (t) => {
  const projects = Array.from({ length: 14 }, (_, i) => unityProject(t, `Project ${i}`));
  let active = 0;
  let peak = 0;
  let spawned = 0;
  const auditor = new ProjectAccessAuditor({
    projects,
    maxActiveProbes: 8,
    spawnProcess: (...args) => {
      const child = spawn(...args);
      spawned += 1;
      active += 1;
      peak = Math.max(peak, active);
      child.once('close', () => { active -= 1; });
      return child;
    },
  });
  t.after(() => auditor.close());

  const result = await auditor.auditAll();
  assert.equal(result.ok, true);
  assert.equal(result.projects.length, 14);
  assert.deepEqual(result.projects.map((item) => item.projectPath), projects.map((item) => item.path));
  assert(result.projects.every((item) => item.code === 'PROJECT_ACCESS_OK'));
  assert.equal(spawned, 14);
  assert(peak <= 8);
  assert.equal(result.activeProbes, 0);
});

test('bulk auditing preserves caller deadlines and does not spawn later batches after expiry', async (t) => {
  const projects = Array.from({ length: 3 }, (_, i) => unityProject(t, `Deadline ${i}`));
  const children = [];
  const auditor = new ProjectAccessAuditor({
    projects,
    maxActiveProbes: 1,
    timeoutMs: 1000,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    for (const child of children) child.emit('close', null, 'SIGKILL');
    await auditor.close();
  });

  const result = await auditor.auditAll(projects, { deadlineAt: Date.now() + 30 });
  assert.equal(result.ok, false);
  assert.equal(result.projects.length, 3);
  assert(result.projects.every((item) => item.code === 'DEADLINE_EXCEEDED'));
  assert.equal(children.length, 1);
  assert.equal(auditor.snapshot().activeProbes, 1, 'caller expiry must not forget the live helper');
});
