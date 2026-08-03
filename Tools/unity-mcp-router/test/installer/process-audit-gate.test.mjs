import test from 'node:test';
import assert from 'node:assert/strict';
import { auditInstallerProcesses, readLiveProcessTable } from '../../scripts/installer-process-audit.mjs';

test('live process-table failures never retain partial stdout or stderr', () => {
  const secret = 'proxy-user:supersecret@example.test';
  let caught;
  try {
    readLiveProcessTable(() => ({
      status: null,
      signal: 'SIGKILL',
      error: Object.assign(new Error('maxBuffer exceeded'), {
        stdout: secret,
        stderr: secret,
        output: [null, secret, secret],
      }),
      stdout: secret,
      stderr: secret,
    }));
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error);
  assert.equal(caught.message, 'process table unavailable');
  assert.equal(JSON.stringify(caught).includes(secret), false);
  assert.equal(String(caught).includes(secret), false);
});

test('installer audit recognizes Unity MCP behind supported global options', () => {
  const result = auditInstallerProcesses(`
  230 1 /Users/u/.unity/bin/unity --verbose mcp --project-path /ProjectA
  231 1 /Users/u/.unity/bin/unity --format ndjson --proxy http://user:supersecret@proxy.test --no-banner mcp --project-path /ProjectB
  232 1 /Users/u/.unity/bin/unity --format=json --proxy=http://proxy.test --quiet mcp --project-path /ProjectC
  233 1 /Users/u/.unity/bin/unity --proxy mcp status
  `);
  assert.deepEqual(result.findings.map((finding) => finding.pid), [230, 231, 232]);
  assert(result.findings.every((finding) => finding.kind === 'direct_unmanaged_unity_mcp'));
  assert(result.findings.every((finding) => !Object.hasOwn(finding, 'command')));
  assert(result.findings.every((finding) => /^[a-f0-9]{64}$/.test(finding.commandSha256)));
  assert.equal(JSON.stringify(result).includes('supersecret'), false);
});

test('installer audit distinguishes managed broker children and ignores command text payloads', () => {
  const root = '/managed/release';
  const result = auditInstallerProcesses(`
  300 1 node --enable-source-maps /managed/release/broker-daemon.mjs --config /c
  301 300 /Users/u/.unity/bin/unity --format ndjson mcp --project-path /ProjectA
  302 1 node /old/unity-mcp-router.mjs --default A
  303 1 node --eval "console.log('/old/unity-mcp-router.mjs unity mcp')"
  304 1 claude --mcp-config '{"args":["/old/unity-mcp-router.mjs"]}'
  305 1 uv tool run unity-code-mcp-stdio
  `, { currentReleaseDir: root });
  assert.deepEqual(result.findings.map((finding) => finding.pid), [302, 305]);
  assert.equal(result.findings[0].kind, 'legacy_or_unattached_adapter');
});
