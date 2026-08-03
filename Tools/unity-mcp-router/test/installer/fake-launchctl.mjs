#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const stateFile = process.env.FAKE_LAUNCHCTL_STATE;
if (!stateFile || !path.isAbsolute(stateFile)) {
  process.stderr.write('FAKE_LAUNCHCTL_STATE must be an absolute path\n');
  process.exit(64);
}

function readState() {
  if (!existsSync(stateFile)) return {
    loaded: false,
    pid: null,
    plist: null,
    events: [],
    failBootstrapCount: 0,
    printFailuresRemaining: 0,
    stoppingPids: [],
  };
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function writeState(value) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, stateFile);
}

function recordStartedPid(pid) {
  const descriptor = openSync(`${stateFile}.started-pids`, 'a', 0o600);
  try {
    writeFileSync(descriptor, `${pid}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function decodeXml(value) {
  return value.replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

function programFromPlist(plist) {
  const text = readFileSync(plist, 'utf8');
  const match = text.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
  if (!match) throw new Error('ProgramArguments missing from plist');
  return decodeXml(match[1]);
}

function startBroker(state) {
  const stoppingPids = Array.isArray(state.stoppingPids)
    ? state.stoppingPids.filter((pid) => isLive(pid))
    : [];
  state.stoppingPids = stoppingPids;
  if (stoppingPids.length > 0) {
    state.events.push({ event: 'start-blocked-by-stopping-pid', pids: stoppingPids, at: Date.now() });
    throw new Error(`refusing overlapping broker start while prior PID(s) remain live: ${stoppingPids.join(',')}`);
  }
  const program = programFromPlist(state.plist);
  const stdoutFile = `${stateFile}.child.stdout`;
  const stderrFile = `${stateFile}.child.stderr`;
  const stdout = openSync(stdoutFile, 'a', 0o600);
  const stderr = openSync(stderrFile, 'a', 0o600);
  const child = spawn(program, [], {
    detached: true,
    env: process.env,
    stdio: ['ignore', stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  try {
    recordStartedPid(child.pid);
  } catch (error) {
    try { child.kill('SIGKILL'); } catch {}
    throw error;
  }
  child.unref();
  state.pid = child.pid;
  state.childStdout = stdoutFile;
  state.childStderr = stderrFile;
  state.events.push({ event: 'start', pid: child.pid, at: Date.now() });
}

function stopBroker(state, exitDelayMs = 0) {
  const pid = state.pid;
  if (isLive(pid)) {
    if (exitDelayMs > 0) {
      const terminator = spawn(process.execPath, [
        '-e',
        'const [pid,delay]=process.argv.slice(1).map(Number);setTimeout(()=>{try{process.kill(pid,"SIGTERM")}catch{}},delay)',
        String(pid),
        String(exitDelayMs),
      ], { detached: true, stdio: 'ignore' });
      terminator.unref();
      if (!Array.isArray(state.stoppingPids)) state.stoppingPids = [];
      if (!state.stoppingPids.includes(pid)) state.stoppingPids.push(pid);
      state.events.push({ event: 'stop-scheduled', pid, at: Date.now(), exitDelayMs });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      const end = Date.now() + 2_000;
      while (Date.now() < end && isLive(pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      if (isLive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }
  state.events.push({ event: 'stop', pid, at: Date.now(), exitDelayMs });
  state.pid = null;
}

const [command, ...args] = process.argv.slice(2);
const state = readState();
try {
  if (command === 'print') {
    const failuresRemaining = Number(state.printFailuresRemaining ?? 0);
    if (!Number.isSafeInteger(failuresRemaining) || failuresRemaining < 0 || failuresRemaining > 1000) {
      throw new Error('printFailuresRemaining must be an integer from 0 to 1000');
    }
    if (failuresRemaining > 0) {
      state.printFailuresRemaining = failuresRemaining - 1;
      state.events.push({ event: 'print-failed-ambiguous', at: Date.now(), exitCode: 70 });
      writeState(state);
      process.exit(70);
    }
    if (!state.loaded) {
      const visibleUntil = Number(state.bootoutVisibleUntil ?? 0);
      if (Number.isFinite(visibleUntil) && visibleUntil > Date.now()) {
        state.events.push({ event: 'bootout-stale-print', at: Date.now(), visibleUntil });
        writeState(state);
        process.stdout.write('state = waiting\n');
        process.exit(0);
      }
      if (visibleUntil > 0) {
        delete state.bootoutVisibleUntil;
        state.events.push({ event: 'bootout-hidden', at: Date.now() });
        writeState(state);
      }
      process.exit(113);
    }
    process.stdout.write(`state = ${isLive(state.pid) ? 'running' : 'waiting'}\n`);
    if (isLive(state.pid)) process.stdout.write(`pid = ${state.pid}\n`);
  } else if (command === 'bootstrap') {
    const plist = args[1];
    if (!plist || !existsSync(plist)) throw new Error('bootstrap plist is missing');
    if ((state.failBootstrapCount ?? 0) > 0) {
      state.failBootstrapCount -= 1;
      state.events.push({ event: 'bootstrap-failed', at: Date.now() });
      writeState(state);
      process.exit(70);
    }
    state.loaded = true;
    delete state.bootoutVisibleUntil;
    state.plist = plist;
    state.events.push({ event: 'bootstrap', plist, at: Date.now() });
    if (!isLive(state.pid)) startBroker(state);
    writeState(state);
  } else if (command === 'kickstart') {
    if (!state.loaded || !state.plist) process.exit(113);
    state.events.push({ event: 'kickstart', at: Date.now() });
    if (!isLive(state.pid)) startBroker(state);
    writeState(state);
  } else if (command === 'bootout') {
    if (!state.loaded) process.exit(113);
    const visibilityMs = Number(process.env.FAKE_LAUNCHCTL_BOOTOUT_VISIBILITY_MS ?? 0);
    const processExitMs = Number(process.env.FAKE_LAUNCHCTL_BOOTOUT_PROCESS_EXIT_MS ?? 0);
    if (!Number.isSafeInteger(visibilityMs) || visibilityMs < 0 || visibilityMs > 30_000) {
      throw new Error('FAKE_LAUNCHCTL_BOOTOUT_VISIBILITY_MS must be an integer from 0 to 30000');
    }
    if (!Number.isSafeInteger(processExitMs) || processExitMs < 0 || processExitMs > 30_000) {
      throw new Error('FAKE_LAUNCHCTL_BOOTOUT_PROCESS_EXIT_MS must be an integer from 0 to 30000');
    }
    stopBroker(state, processExitMs);
    state.loaded = false;
    if (visibilityMs > 0) state.bootoutVisibleUntil = Date.now() + visibilityMs;
    state.events.push({ event: 'bootout', at: Date.now(), visibilityMs, processExitMs });
    writeState(state);
  } else {
    process.stderr.write(`unsupported fake launchctl command: ${command ?? ''}\n`);
    process.exit(64);
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(70);
}
