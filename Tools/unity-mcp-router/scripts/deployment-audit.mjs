#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SHA = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const MANAGED_RUNTIME_STORAGE = 'managed-content-addressed-v1';

function fail(message) {
  process.stderr.write(`deployment-audit: ${message}\n`);
  process.exit(65);
}

function shaFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readLine(file) {
  const text = readFileSync(file, 'utf8');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) fail(`invalid single-line metadata: ${path.basename(file)}`);
  return text.slice(0, -1);
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value == null || Object.hasOwn(values, flag)) fail('invalid or duplicate option');
    values[flag] = value;
  }
  if (!values['--prefix'] || !values['--target']) fail('--prefix and --target are required');
  return values;
}

function assertRealDirectory(directory, expectedParent) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`not a real directory: ${directory}`);
  const canonical = realpathSync.native(directory);
  if (canonical !== directory) fail(`directory is not canonical: ${directory}`);
  if (expectedParent && path.dirname(canonical) !== expectedParent) fail(`directory escapes managed parent: ${directory}`);
}

function assertManagedRuntime(prefix, identity) {
  if (identity.nodeStorage !== MANAGED_RUNTIME_STORAGE) fail('invalid managed node storage discriminator');
  const uid = process.getuid?.();
  const assertOwnedDirectory = (directory, expectedParent, expectedMode) => {
    assertRealDirectory(directory, expectedParent);
    const stat = lstatSync(directory);
    if ((uid != null && stat.uid !== uid) || (stat.mode & 0o777) !== expectedMode) {
      fail(`managed runtime directory ownership/mode mismatch: ${directory}`);
    }
  };
  const runtimesRoot = path.join(prefix, 'runtimes');
  assertOwnedDirectory(runtimesRoot, prefix, 0o700);
  const runtimeRoot = path.join(runtimesRoot, identity.nodeSha256);
  assertOwnedDirectory(runtimeRoot, runtimesRoot, 0o500);
  if (JSON.stringify(readdirSync(runtimeRoot).sort()) !== JSON.stringify(['node'])) {
    fail('managed runtime file set mismatch');
  }
  const node = path.join(runtimeRoot, 'node');
  if (identity.nodeBin !== node) fail('managed node path is not derived from prefix and checksum');
  const stat = lstatSync(node);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync.native(node) !== node ||
      (uid != null && stat.uid !== uid) || (stat.mode & 0o777) !== 0o500 || stat.nlink !== 1 ||
      shaFile(node) !== identity.nodeSha256) fail('managed node identity mismatch');
}

function collectFiles(root) {
  const files = [];
  const visit = (directory, relative = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`symlink is forbidden in immutable payload: ${childRelative}`);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) files.push(childRelative);
      else fail(`unsupported filesystem entry: ${childRelative}`);
    }
  };
  visit(root);
  return files.sort();
}

function verifyManifest(root) {
  const manifestFile = path.join(root, 'SHA256SUMS');
  const lines = readFileSync(manifestFile, 'utf8').split('\n').filter(Boolean);
  const entries = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/);
    if (!match || path.isAbsolute(match[2]) || match[2].split('/').includes('..') || match[2] === 'SHA256SUMS') {
      fail(`unsafe manifest entry in ${manifestFile}`);
    }
    if (entries.has(match[2])) fail(`duplicate manifest entry: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  const actual = collectFiles(root).filter((file) => file !== 'SHA256SUMS');
  const expected = [...entries.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`manifest file set mismatch in ${root}`);
  for (const [relative, expectedSha] of entries) {
    if (shaFile(path.join(root, relative)) !== expectedSha) fail(`manifest hash mismatch: ${relative}`);
  }
  return shaFile(manifestFile);
}

const options = parseOptions(process.argv.slice(2));
const prefix = realpathSync.native(path.resolve(options['--prefix']));
const target = options['--target'];
const match = target.match(/^deployments\/([A-Za-z0-9._-]+)$/);
if (!match || target.includes('..')) fail(`unsafe deployment target: ${target}`);
const deploymentsRoot = path.join(prefix, 'deployments');
assertRealDirectory(deploymentsRoot, prefix);
const deployment = path.join(deploymentsRoot, match[1]);
assertRealDirectory(deployment, deploymentsRoot);
const deploymentManifestSha256 = verifyManifest(deployment);

const identityFile = path.join(deployment, 'identity.json');
const identitySha256 = shaFile(identityFile);
const expectedDeploymentId = `d-${identitySha256.slice(0, 32)}`;
if (match[1] !== expectedDeploymentId) fail('deployment directory does not match identity hash');
const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
const deploymentMetadata = JSON.parse(readFileSync(path.join(deployment, 'deployment.json'), 'utf8'));
if (identity.version !== 1 || deploymentMetadata.deploymentId !== expectedDeploymentId ||
    deploymentMetadata.identitySha256 !== identitySha256 ||
    JSON.stringify(deploymentMetadata.identity) !== JSON.stringify(identity)) fail('deployment metadata/identity mismatch');

for (const field of ['releaseId', 'configId', 'label']) {
  if (typeof identity[field] !== 'string' || !SAFE_ID.test(identity[field]) || identity[field].includes('..')) fail(`invalid identity ${field}`);
}
for (const field of ['releaseManifestSha256', 'sourceSha256', 'configSha256', 'configFingerprint', 'nodeSha256', 'plistSha256']) {
  if (!SHA.test(identity[field] ?? '')) fail(`invalid identity ${field}`);
}
if (!Number.isInteger(identity.journalFormat) || !['live', 'staging'].includes(identity.installMode)) fail('invalid deployment mode/format');
if (options['--expected-label'] && identity.label !== options['--expected-label']) fail('deployment label mismatch');
if (identity.prefix !== prefix) fail('deployment prefix mismatch');
if (path.resolve(identity.launchAgentsDir) !== identity.launchAgentsDir || path.resolve(identity.launchctlBin) !== identity.launchctlBin) fail('deployment path metadata is not absolute');
if (identity.releaseId !== `${identity.releaseVersion}-${identity.sourceSha256.slice(0, 12)}` ||
    identity.configId !== `${identity.releaseId}-${identity.configSha256.slice(0, 12)}` ||
    identity.buildId !== `sha256:${identity.sourceSha256}`) fail('derived deployment identity mismatch');

const expectedPayloads = [
  'config.json', 'launch-agent.plist', 'broker-admin.mjs', 'broker-launcher.sh',
  'adapter-launcher.sh', 'admin-launcher.sh', 'rollback-launcher.sh',
  'rollback-router.sh', 'inspect-journal.mjs', 'install-state.mjs', 'deployment-audit.mjs',
].sort();
if (JSON.stringify(Object.keys(identity.payloads ?? {}).sort()) !== JSON.stringify(expectedPayloads)) fail('identity payload set mismatch');
for (const relative of expectedPayloads) {
  if (!SHA.test(identity.payloads[relative] ?? '') || shaFile(path.join(deployment, relative)) !== identity.payloads[relative]) {
    fail(`identity payload hash mismatch: ${relative}`);
  }
}
if (identity.configSha256 !== shaFile(path.join(deployment, 'config.json')) ||
    identity.plistSha256 !== shaFile(path.join(deployment, 'launch-agent.plist'))) fail('config/plist identity mismatch');

const metadata = {
  'release-id.txt': identity.releaseId,
  'config-id.txt': identity.configId,
  'journal-format.txt': String(identity.journalFormat),
  'node-bin.txt': identity.nodeBin,
  'node-sha256.txt': identity.nodeSha256,
  'label.txt': identity.label,
  'launch-agents-dir.txt': identity.launchAgentsDir,
  'launchctl-bin.txt': identity.launchctlBin,
  'install-mode.txt': identity.installMode,
};
for (const [relative, expected] of Object.entries(metadata)) {
  if (readLine(path.join(deployment, relative)) !== expected) fail(`identity metadata mismatch: ${relative}`);
}

const plist = readFileSync(path.join(deployment, 'launch-agent.plist'), 'utf8');
for (const expected of [
  `<key>Label</key>\n  <string>${xmlEscape(identity.label)}</string>`,
  `<string>${xmlEscape(identity.prefix)}/current/broker-launcher.sh</string>`,
  `<key>WorkingDirectory</key>\n  <string>${xmlEscape(identity.prefix)}/current</string>`,
]) {
  if (!plist.includes(expected)) fail('LaunchAgent plist semantic identity mismatch');
}

const nodeStat = lstatSync(identity.nodeBin);
if (identity.nodeStorage === undefined) {
  // Compatibility for already-installed immutable v1 deployments. Their Node
  // path may be external, but the original exact regular-file/hash semantics
  // remain enforced so either side of the first migration can roll back.
  if (nodeStat.isSymbolicLink() || !nodeStat.isFile() || realpathSync.native(identity.nodeBin) !== identity.nodeBin ||
      shaFile(identity.nodeBin) !== identity.nodeSha256) fail('pinned node identity mismatch');
} else {
  assertManagedRuntime(prefix, identity);
}

const releasesRoot = path.join(prefix, 'releases');
assertRealDirectory(releasesRoot, prefix);
const release = path.join(releasesRoot, identity.releaseId);
assertRealDirectory(release, releasesRoot);
if (verifyManifest(release) !== identity.releaseManifestSha256) fail('release manifest identity mismatch');
if (shaFile(path.join(release, 'SOURCE_SHA256SUMS')) !== identity.sourceSha256) fail('release source manifest identity mismatch');
const releaseMetadata = JSON.parse(readFileSync(path.join(release, 'release.json'), 'utf8'));
if (releaseMetadata.version !== identity.releaseVersion || releaseMetadata.buildId !== identity.buildId ||
    releaseMetadata.journalFormat !== identity.journalFormat) fail('release metadata identity mismatch');

process.stdout.write(`${JSON.stringify({
  ok: true,
  target,
  deploymentId: expectedDeploymentId,
  deployment,
  deploymentManifestSha256,
  identitySha256,
  identity,
})}\n`);
