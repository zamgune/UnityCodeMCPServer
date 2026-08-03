#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: inspect-journal.mjs FILE\n');
  process.exit(64);
}

let bytes;
try {
  bytes = readFileSync(file);
} catch (error) {
  if (error?.code === 'ENOENT') {
    process.stdout.write(`${JSON.stringify({ exists: false, empty: true, versions: [], hasV2: false, nonTerminal: [], nonTerminalV2: [] })}\n`);
    process.exit(0);
  }
  throw error;
}

const lastNewline = bytes.lastIndexOf(0x0a);
const complete = lastNewline < 0 ? '' : bytes.subarray(0, lastNewline + 1).toString('utf8');
const versions = new Set();
const latest = new Map();
let lineNumber = 0;
for (const line of complete.split('\n')) {
  lineNumber += 1;
  if (!line.trim()) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    process.stderr.write(`malformed complete journal record at line ${lineNumber}\n`);
    process.exit(65);
  }
  if (!record || typeof record !== 'object' || !Number.isInteger(record.version)) {
    process.stderr.write(`invalid complete journal record at line ${lineNumber}\n`);
    process.exit(65);
  }
  versions.add(record.version);
  if (typeof record.operationId === 'string' && typeof record.state === 'string') {
    latest.set(record.operationId, { state: record.state, version: record.version });
  }
}

const terminal = new Set(['COMPLETED', 'CANCELLED', 'RESOLVED']);
const nonTerminal = [...latest]
  .filter(([, record]) => !terminal.has(record.state))
  .map(([operationId, record]) => ({ operationId, state: record.state, version: record.version }));
const nonTerminalV2 = [...latest]
  .filter(([, record]) => record.version === 2 && !terminal.has(record.state))
  .map(([operationId, record]) => ({ operationId, state: record.state }));
process.stdout.write(`${JSON.stringify({
  exists: true,
  empty: bytes.length === 0,
  versions: [...versions].sort(),
  hasV2: versions.has(2),
  nonTerminal,
  nonTerminalV2,
})}\n`);
