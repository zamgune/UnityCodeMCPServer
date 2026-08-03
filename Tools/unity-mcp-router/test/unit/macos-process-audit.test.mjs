import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditProcessTable,
  auditSystemProcesses,
  listProcesses,
  parseProcessTable,
} from '../../lib/macos-process-audit.mjs';

test('bounds the process-table child with a hard timeout and SIGKILL', async () => {
  let invocation = null;
  const rows = await listProcesses({
    timeoutMs: 321,
    execFileImpl(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, '  10  1 node /installed/broker-daemon.mjs\n');
    },
  });
  assert.equal(invocation.file, '/bin/ps');
  assert.deepEqual(invocation.args, ['-axo', 'pid=,ppid=,command=']);
  assert.equal(invocation.options.timeout, 321);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert(invocation.options.maxBuffer >= 1024 * 1024);
  assert.deepEqual(rows, [{ pid: 10, ppid: 1, command: 'node /installed/broker-daemon.mjs' }]);
});

test('fails closed when the bounded process-table read times out', async () => {
  const result = await auditSystemProcesses({}, {
    listProcessesImpl: async () => {
      const error = new Error('process audit timed out');
      error.killed = true;
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.editors, []);
  assert(result.findings.some((finding) =>
    finding.kind === 'process_audit_failed' && finding.message === 'process audit timed out'));
});

test('parses ps output and detects unmanaged direct/legacy MCP processes', () => {
  const rows = parseProcessTable(`
  10  1 node /installed/broker-daemon.mjs --config /c
  20 10 /Users/u/.unity/bin/unity mcp --project-path /ProjectA
  21  1 /Users/u/.unity/bin/unity mcp --project-path /ProjectB
  30  1 node /old/unity-mcp-router.mjs --default A
  `);
  const result = auditProcessTable(rows, { brokerPid: 10, childPids: [20], adapterPids: [] });
  assert.equal(result.ok, false);
  assert(result.findings.some((finding) => finding.kind === 'direct_unmanaged_unity_mcp' && finding.pid === 21));
  assert(result.findings.some((finding) => finding.kind === 'legacy_or_unattached_adapter' && finding.pid === 30));
  assert(!result.findings.some((finding) => finding.pid === 20));
});

test('detects duplicate project Editors and configured seat overflow', () => {
  const rows = parseProcessTable(`
  100 1 /Applications/Unity/Hub/Editor/6000.3.13f1/Unity.app/Contents/MacOS/Unity -projectPath /ProjectA
  101 1 /Applications/Unity/Hub/Editor/6000.3.13f1/Unity.app/Contents/MacOS/Unity -projectPath "/ProjectA"
  `);
  const result = auditProcessTable(rows, { configuredProjectPaths: ['/ProjectA'], maxConcurrentEditors: 1 });
  assert(result.findings.some((finding) => finding.kind === 'duplicate_project_editor'));
  assert(result.findings.some((finding) => finding.kind === 'editor_seat_limit_exceeded'));
});

test('does not count AssetImportWorker helper processes as additional Editors', () => {
  const rows = parseProcessTable(`
  100 1 /Applications/Unity/Hub/Editor/6000.3.17f1/Unity.app/Contents/MacOS/Unity -projectpath /ProjectA -useHub
  101 100 /Applications/Unity/Hub/Editor/6000.3.17f1/Unity.app/Contents/MacOS/Unity -adb2 -batchMode -name AssetImportWorker0 -projectPath /ProjectA -name AssetImport
  102 100 /Applications/Unity/Hub/Editor/6000.3.17f1/Unity.app/Contents/MacOS/Unity -adb2 -batchMode -name AssetImportWorker1 -projectPath /ProjectA -name AssetImport
  `);
  const result = auditProcessTable(rows, {
    configuredProjectPaths: ['/ProjectA'],
    maxConcurrentEditors: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.editors, [{ pid: 100, projectPath: '/ProjectA' }]);
});

test('fails closed on non-canonical or unknown Editor project paths even with two seats', () => {
  const rows = parseProcessTable(`
  110 1 /Applications/Unity/Hub/Editor/6000.3.17f1/Unity.app/Contents/MacOS/Unity -projectPath /CanonicalProject
  111 1 /Applications/Unity/Hub/Editor/6000.3.17f1/Unity.app/Contents/MacOS/Unity -projectPath /SymlinkAlias
  `);
  const result = auditProcessTable(rows, {
    configuredProjectPaths: ['/CanonicalProject'],
    maxConcurrentEditors: 2,
  });
  assert.equal(result.ok, false);
  assert(result.findings.some((finding) =>
    finding.kind === 'unconfigured_editor' && finding.pid === 111 && finding.severity === 'error'));

  const unknown = auditProcessTable(parseProcessTable(`
  112 1 /Applications/Unity/Hub/Editor/6000.3.17f1/Unity.app/Contents/MacOS/Unity -batchmode
  `), { configuredProjectPaths: ['/CanonicalProject'], maxConcurrentEditors: 2 });
  assert.equal(unknown.ok, false);
  assert(unknown.findings.some((finding) =>
    finding.kind === 'editor_project_unknown' && finding.pid === 112 && finding.severity === 'error'));
});

test('does not classify commands that merely mention managed script names', () => {
  const rows = parseProcessTable(`
  200 1 /bin/zsh -c node /installed/broker-daemon.mjs --config /c
  201 1 /Applications/Claude.app/Contents/MacOS/Claude --mcp-config {"command":"node","args":["/old/unity-mcp-router.mjs"]}
  202 1 node --input-type=module --eval import './lib/macos-process-audit.mjs';
  `);
  const result = auditProcessTable(rows, { brokerPid: 999 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test('classifies only actual broker, adapter, and direct Unity CLI executables', () => {
  const rows = parseProcessTable(`
  210 1 /opt/node/bin/node /installed/broker-daemon.mjs --config /c
  211 1 /opt/node/bin/node /old/unity-mcp-router.mjs --default A
  212 1 /opt/bin/uv run --directory /old/STDIO~ unity-code-mcp-stdio
  213 1 /Users/u/.unity/bin/unity mcp --project-path /ProjectA
  `);
  const result = auditProcessTable(rows, { brokerPid: 999 });
  assert(result.findings.some((finding) => finding.kind === 'duplicate_broker' && finding.pid === 210));
  assert(result.findings.some((finding) => finding.kind === 'legacy_or_unattached_adapter' && finding.pid === 211));
  assert(result.findings.some((finding) => finding.kind === 'legacy_or_unattached_adapter' && finding.pid === 212));
  assert(result.findings.some((finding) => finding.kind === 'direct_unmanaged_unity_mcp' && finding.pid === 213));
});

test('recognizes managed scripts behind ordinary Node runtime flags but not eval payloads', () => {
  const rows = parseProcessTable(`
  220 1 node --enable-source-maps /installed/broker-daemon.mjs --config /c
  221 1 node --no-warnings /old/unity-mcp-router.mjs --default A
  222 1 node --input-type=module --eval console.log('/old/unity-mcp-router.mjs')
  `);
  const result = auditProcessTable(rows, { brokerPid: 999 });
  assert(result.findings.some((finding) => finding.kind === 'duplicate_broker' && finding.pid === 220));
  assert(result.findings.some((finding) => finding.kind === 'legacy_or_unattached_adapter' && finding.pid === 221));
  assert(!result.findings.some((finding) => finding.pid === 222));
});

test('recognizes direct Unity MCP after supported global CLI options without treating option values as commands', () => {
  const rows = parseProcessTable(`
  230 1 /Users/u/.unity/bin/unity --verbose mcp --project-path /ProjectA
  231 1 /Users/u/.unity/bin/unity --format ndjson --proxy http://proxy.test --no-banner mcp --project-path /ProjectB
  232 1 /Users/u/.unity/bin/unity --format=json --proxy=http://proxy.test --quiet mcp --project-path /ProjectC
  233 1 /Users/u/.unity/bin/unity --proxy mcp status
  `);
  const result = auditProcessTable(rows, { brokerPid: 999 });
  assert(result.findings.some((finding) => finding.kind === 'direct_unmanaged_unity_mcp' && finding.pid === 230));
  assert(result.findings.some((finding) => finding.kind === 'direct_unmanaged_unity_mcp' && finding.pid === 231));
  assert(result.findings.some((finding) => finding.kind === 'direct_unmanaged_unity_mcp' && finding.pid === 232));
  assert(!result.findings.some((finding) => finding.pid === 233));
});
