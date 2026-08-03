#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function usage() {
  process.stderr.write('usage: installer-process-audit.mjs (--live | --process-table FILE) [--current-release-dir DIR]\n');
  process.exit(64);
}

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (flag === '--live') {
      if (values.live) usage();
      values.live = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!['--process-table', '--current-release-dir'].includes(flag) || value == null || Object.hasOwn(values, flag)) usage();
    values[flag] = value;
    index += 2;
  }
  if (Boolean(values.live) === Boolean(values['--process-table'])) usage();
  return values;
}

export function commandWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaping = false;
  for (const char of String(command ?? '')) {
    if (escaping) { word += char; escaping = false; }
    else if (char === '\\' && quote !== "'") escaping = true;
    else if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (word) { words.push(word); word = ''; } }
    else word += char;
  }
  if (word) words.push(word);
  return words;
}

function executableName(words) {
  return words[0] ? path.basename(words[0]) : '';
}

function nodeScript(words) {
  if (executableName(words) !== 'node') return null;
  const evalFlags = new Set(['-e', '--eval', '-p', '--print', '-c', '--check']);
  const optionsWithValue = new Set([
    '-r', '--require', '--loader', '--experimental-loader', '--import',
    '--conditions', '--input-type', '--inspect-port', '--title',
  ]);
  let index = 1;
  while (index < words.length) {
    const value = words[index];
    if (value === '--') return words[index + 1] ?? null;
    const optionName = value.split('=', 1)[0];
    if (evalFlags.has(optionName)) return null;
    if (!value.startsWith('-')) return value;
    if (optionsWithValue.has(optionName) && !value.includes('=')) index += 2;
    else index += 1;
  }
  return null;
}

const UNITY_GLOBAL_OPTIONS_WITH_VALUE = new Set(['--format', '--proxy']);

function unitySubcommand(words) {
  let index = 1;
  while (index < words.length) {
    const value = words[index];
    if (value === '--') return words[index + 1] ?? null;
    if (!value.startsWith('-')) return value;
    const optionName = value.split('=', 1)[0];
    if (UNITY_GLOBAL_OPTIONS_WITH_VALUE.has(optionName) && !value.includes('=')) index += 2;
    else index += 1;
  }
  return null;
}

function isUnityMcp(words) {
  return executableName(words).toLowerCase() === 'unity' && unitySubcommand(words) === 'mcp';
}

function routerKind(words) {
  const executable = executableName(words);
  const script = path.basename(nodeScript(words) ?? '');
  if (script === 'broker-daemon.mjs' || executable === 'broker-daemon.mjs') return 'broker';
  if (script === 'unity-mcp-router.mjs' || executable === 'unity-mcp-router.mjs' || executable === 'unity-code-mcp-stdio') return 'adapter';
  if (executable === 'uv' && words.includes('unity-code-mcp-stdio')) return 'adapter';
  return null;
}

function scriptUnder(words, root) {
  if (!root) return false;
  const script = nodeScript(words);
  if (!script || !path.isAbsolute(script)) return false;
  const relative = path.relative(root, path.normalize(script));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function auditInstallerProcesses(text, { currentReleaseDir = '' } = {}) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3], words: commandWords(match[3]) });
  }
  const managedBrokerPids = new Set(rows
    .filter((row) => routerKind(row.words) === 'broker' && scriptUnder(row.words, currentReleaseDir))
    .map((row) => row.pid));
  const findings = [];
  for (const row of rows) {
    const unity = isUnityMcp(row.words);
    const kind = routerKind(row.words);
    const managedRouter = kind != null && scriptUnder(row.words, currentReleaseDir);
    const managedUnity = unity && managedBrokerPids.has(row.ppid);
    if ((unity || kind != null) && !managedRouter && !managedUnity) {
      findings.push({
        pid: row.pid,
        ppid: row.ppid,
        kind: unity ? 'direct_unmanaged_unity_mcp' : kind === 'broker' ? 'duplicate_broker' : 'legacy_or_unattached_adapter',
        commandSha256: createHash('sha256').update(row.command).digest('hex'),
      });
    }
  }
  return { ok: findings.length === 0, count: findings.length, findings };
}

export function readLiveProcessTable(run = spawnSync) {
  const result = run('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== 'string') {
    throw new Error('process table unavailable');
  }
  return result.stdout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  let processTable;
  try {
    processTable = options.live ? readLiveProcessTable() : readFileSync(options['--process-table'], 'utf8');
  } catch {
    process.stderr.write('installer-process-audit: process table unavailable\n');
    process.exit(70);
  }
  const result = auditInstallerProcesses(processTable, {
    currentReleaseDir: options['--current-release-dir'] ? path.resolve(options['--current-release-dir']) : '',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
