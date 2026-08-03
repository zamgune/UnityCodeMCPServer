#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function usage() {
  process.stderr.write(
    'usage: prepare-config.mjs <prepare|inspect> --runtime-root DIR --input FILE [--output FILE]\n',
  );
  process.exit(64);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'prepare' && command !== 'inspect') usage();
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!['--runtime-root', '--input', '--output'].includes(flag)) usage();
    const value = rest[++index];
    if (!value || value.startsWith('--')) usage();
    values[flag.slice(2).replaceAll('-', '_')] = value;
  }
  if (!values.runtime_root || !values.input || (command === 'prepare' && !values.output)) usage();
  return values;
}

function serializableConfig(config) {
  const projects = config.projects.map((project) => ({
    key: project.key,
    aliases: [...project.aliases],
    path: project.path,
    identity: { ...project.identity },
    unityBin: project.unityBin,
    extraArgs: [...project.extraArgs],
  }));
  return {
    schemaVersion: config.schemaVersion,
    projectIdentityFormat: 'canonical-devino-v1',
    unityBin: config.unityBin,
    unityArgs: [...config.unityArgs],
    minimumCliVersion: config.minimumCliVersion,
    defaultProject: config.defaultProject,
    projects,
    logFile: config.logFile,
    startupTimeoutSec: config.startupTimeoutSec,
    toolTimeoutSec: config.toolTimeoutSec,
    reauthIntervalMin: config.reauthIntervalMin,
    queue: { ...config.queue },
    recovery: {
      safeReadRetries: config.recovery.safeReadRetries,
      toolClasses: { ...config.recovery.toolClasses },
    },
    license: { ...config.license },
    editorHandoff: { ...config.editorHandoff },
    broker: { ...config.broker },
    // Installed adapters are never allowed to auto-spawn a broker. launchd is
    // the sole broker owner; both Codex and Claude use the stable wrapper.
    brokerMode: 'connect-only',
  };
}

const args = parseArgs(process.argv.slice(2));
const runtimeRoot = path.resolve(args.runtime_root);
const input = path.resolve(args.input);
const moduleUrl = pathToFileURL(path.join(runtimeRoot, 'lib', 'config.mjs')).href;
const { configFingerprint, loadConfig } = await import(moduleUrl);
const config = loadConfig({
  argv: ['--config', input],
  env: {},
  cwd: path.dirname(input),
  homeDir: homedir(),
  defaultConfigPath: input,
});

if (args.command === 'prepare') {
  // Parse the raw file first so malformed JSON fails before any target switch.
  JSON.parse(readFileSync(input, 'utf8'));
  writeFileSync(args.output, `${JSON.stringify(serializableConfig(config), null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(args.output, 0o600);
}

process.stdout.write(`${JSON.stringify({
  configHash: configFingerprint(config),
  journalFile: config.broker.journalFile,
  workspaceLeaseFile: config.broker.workspaceLeaseFile,
  socketPath: config.broker.socketPath,
  brokerMode: args.command === 'prepare' ? 'connect-only' : config.brokerMode,
})}\n`);
