import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildRouterArgs,
  CliUsageError,
  executeCommand,
  parseCliArgs,
  RouterSession,
} from '../../router-cli.mjs';
import { JsonRpcLineDecoder, encodeJsonRpcLine } from '../../lib/mcp-framing.mjs';

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function toolResponse(id, { isError = false, structuredContent, text = 'ok' } = {}) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      ...(structuredContent === undefined ? {} : { structuredContent }),
      ...(isError ? { isError: true } : {}),
    },
  };
}

class StubSession {
  constructor(handler) {
    this.handler = handler;
    this.requests = [];
  }

  async request(method, params, options) {
    this.requests.push({ method, params, options });
    return this.handler(method, params, options, this.requests.length);
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.stdin.once('finish', () => setImmediate(() => this.finish(0, null)));
  }

  kill(signal) {
    this.finish(null, signal);
    return true;
  }

  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit('exit', code, signal);
  }
}

test('forwards only adapter globals and uses target project as an implicit default', () => {
  const explicit = parseCliArgs([
    '--config', '/router/config.json', 'list', '--broker-mode', 'connect-only',
    '--default', 'A', '--project', 'B', '--json',
  ]);
  assert.equal(explicit.command, 'list');
  assert.equal(explicit.project, 'B');
  assert.equal(explicit.json, true);
  assert.deepEqual(buildRouterArgs(explicit, '/adapter.mjs'), [
    '/adapter.mjs', '--config', '/router/config.json', '--broker-mode', 'connect-only', '--default', 'A',
  ]);

  const implicit = parseCliArgs(['list', '--project', 'B']);
  assert.deepEqual(buildRouterArgs(implicit, '/adapter.mjs'), ['/adapter.mjs', '--default', 'B']);
  assert.throws(() => parseCliArgs(['status', '--broker-mode', 'typo']), /auto or connect-only/);
});

test('requests admin capability only for dedicated maintenance commands', () => {
  const cases = [
    ['drain'],
    ['resume'],
    ['restart', 'A'],
    ['workspace', 'resolve', 'lease-token', '--confirm'],
    ['operation', 'resolve', 'op-1', 'abandoned'],
  ];
  for (const argv of cases) {
    assert(buildRouterArgs(parseCliArgs(argv), '/adapter.mjs').includes('--admin'), argv.join(' '));
  }
  for (const argv of [
    ['status'], ['doctor'], ['smoke', 'A'], ['list'],
    ['workspace', 'guard', 'A', '--', '/usr/bin/true'],
    ['operation', 'status', 'op-1'],
    ['call', 'unity_router_drain'],
  ]) {
    assert(!buildRouterArgs(parseCliArgs(argv), '/adapter.mjs').includes('--admin'), argv.join(' '));
  }
});

test('call parses an object, injects project, and rejects ambiguous targeting', () => {
  const parsed = parseCliArgs(['call', 'editor_status', '{"verbose":true}', '--project', 'A']);
  assert.deepEqual(parsed.toolArgs, { verbose: true, project: 'A' });
  assert.throws(
    () => parseCliArgs(['call', 'editor_status', '{"project":"B"}', '--project', 'A']),
    CliUsageError,
  );
  assert.throws(() => parseCliArgs(['call', 'editor_status', '[]']), CliUsageError);
});

test('workspace guard preserves guarded flags after -- and rejects one-shot lease actions', () => {
  const parsed = parseCliArgs([
    '--config', '/c', 'workspace', 'guard', 'A', '--ttl-sec', '90', '--',
    '/usr/bin/tool', '--project', 'child-value', '--json',
  ]);
  assert.equal(parsed.workspaceAction, 'guard');
  assert.equal(parsed.project, 'A');
  assert.equal(parsed.ttlSec, 90);
  assert.equal(parsed.json, false);
  assert.equal(parsed.guardedCommand, '/usr/bin/tool');
  assert.deepEqual(parsed.guardedArgs, ['--project', 'child-value', '--json']);

  assert.throws(() => parseCliArgs(['workspace', 'begin', 'A']), /guard or resolve/);
  assert.throws(() => parseCliArgs(['workspace', 'resolve', 'token']), /--confirm/);
  assert.equal(parseCliArgs(['workspace-resolve', 'token', '--confirm']).workspaceAction, 'resolve');
});

test('operation resolve has a constrained resolution vocabulary and explicit RUNNING confirmation', async () => {
  assert.throws(
    () => parseCliArgs(['operation', 'resolve', 'op-1', 'safe_to_retry']),
    /confirmed_completed or abandoned/,
  );
  const parsed = parseCliArgs([
    'operation', 'resolve', 'op-1', 'confirmed_completed', '--confirm-no-longer-running',
  ]);
  assert.equal(parsed.confirmNoLongerRunning, true);
  assert.throws(() => parseCliArgs(['operation', 'status', 'op-1', '--confirm-no-longer-running']), /only with operation resolve/);

  const session = new StubSession((_method, _params, _options, sequence) => toolResponse(sequence));
  assert.equal(await executeCommand(parsed, session, { io: captureIo().io }), 0);
  assert.deepEqual(session.requests[0].params, {
    name: 'unity_router_operation_resolve',
    arguments: {
      operationId: 'op-1',
      resolution: 'confirmed_completed',
      confirmNoLongerRunning: true,
    },
  });
});

test('RouterSession uses the shared framing codec for split responses and notifications', async () => {
  const child = new FakeChild();
  const requests = [];
  const decoder = new JsonRpcLineDecoder();
  child.stdin.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      requests.push(message);
      if (message.id == null) continue;
      const response = encodeJsonRpcLine({ jsonrpc: '2.0', id: message.id, result: { accepted: true } });
      child.stdout.write(response.subarray(0, 3));
      child.stdout.write(response.subarray(3));
    }
  });

  const session = new RouterSession(child, { requestTimeoutMs: 500 });
  await session.initialize();
  const response = await session.request('tools/list', {});
  assert.deepEqual(response.result, { accepted: true });
  assert.equal(requests[0].method, 'initialize');
  assert.equal(requests[1].method, 'notifications/initialized');
  assert.equal(requests[2].method, 'tools/list');
  await session.close();
});

test('doctor and smoke return nonzero when diagnostic tool results report isError', async () => {
  const doctorIo = captureIo();
  const doctor = new StubSession((_method, params, _options, sequence) => toolResponse(sequence, {
    isError: params.name === 'unity_router_doctor',
    text: 'direct bypass detected',
  }));
  assert.equal(await executeCommand(parseCliArgs(['doctor']), doctor, { io: doctorIo.io }), 1);
  assert.match(doctorIo.stderr(), /direct bypass detected/);

  const smokeIo = captureIo();
  const smoke = new StubSession((_method, params, _options, sequence) => toolResponse(sequence, {
    isError: params.name === 'unity_router_doctor',
    text: params.name,
  }));
  assert.equal(await executeCommand(parseCliArgs(['smoke', 'A']), smoke, { io: smokeIo.io }), 1);
  assert.deepEqual(smoke.requests.map((entry) => entry.params.name), [
    'unity_router_status', 'unity_router_doctor', 'editor_status',
  ]);
  assert.match(smokeIo.stdout(), /FAIL/);
});

test('status and doctor never consult an inherited workspace cwd', async () => {
  for (const command of ['status', 'doctor']) {
    const captured = captureIo();
    const session = new StubSession((_method, _params, _options, sequence) => toolResponse(sequence));
    const runtime = { io: captured.io };
    Object.defineProperty(runtime, 'cwd', {
      get() { throw new Error('workspace cwd must stay lazy'); },
    });
    assert.equal(await executeCommand(parseCliArgs([command]), session, runtime), 0);
  }
});

test('workspace guard acquires and releases in one session while forwarding command arguments', async () => {
  const calls = [];
  const session = new StubSession((_method, params, _options, sequence) => {
    calls.push(params);
    if (params.name === 'unity_router_workspace_begin') {
      return toolResponse(sequence, {
        structuredContent: { token: 'lease-1', project: 'A', expiresAt: 123 },
        text: 'acquired',
      });
    }
    return toolResponse(sequence, { text: 'released' });
  });
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const spawned = [];
  const io = captureIo();
  const exitCodePromise = executeCommand(
    parseCliArgs(['workspace', 'guard', 'A', '--', '/usr/bin/true', '--child-flag']),
    session,
    {
      io: io.io,
      signalEmitter: new EventEmitter(),
      spawnCommand(command, args, options) {
        spawned.push({ command, args, options });
        setImmediate(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        });
        return child;
      },
    },
  );
  assert.equal(await exitCodePromise, 0);
  assert.deepEqual(calls.map((entry) => entry.name), [
    'unity_router_workspace_begin', 'unity_router_workspace_end',
  ]);
  assert.deepEqual(spawned[0].args, ['--child-flag']);
  assert.equal(calls[1].arguments.leaseToken, 'lease-1');
  assert.match(io.stdout(), /lease acquired/);
  assert.match(io.stdout(), /lease released/);
});

test('workspace guard heartbeats and reports a recoverable token when release fails', async () => {
  let heartbeatCount = 0;
  const session = new StubSession((_method, params, _options, sequence) => {
    if (params.name === 'unity_router_workspace_begin') {
      return toolResponse(sequence, { structuredContent: { token: 'orphan-token', project: 'A' } });
    }
    if (params.name === 'unity_router_workspace_heartbeat') {
      heartbeatCount += 1;
      return toolResponse(sequence);
    }
    if (params.name === 'unity_router_workspace_end') {
      return toolResponse(sequence, {
        isError: true,
        structuredContent: { code: 'WORKSPACE_ASYNC_ACTIVE' },
        text: 'tracked operation still running',
      });
    }
    throw new Error(`unexpected tool ${params.name}`);
  });
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const io = captureIo();
  const result = executeCommand(
    parseCliArgs(['workspace', 'guard', 'A', '--ttl-sec', '30', '--', '/usr/bin/true']),
    session,
    {
      io: io.io,
      signalEmitter: new EventEmitter(),
      workspaceHeartbeatIntervalMs: 5,
      spawnCommand() {
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }, 20);
        return child;
      },
    },
  );
  assert.equal(await result, 1);
  assert(heartbeatCount >= 1);
  assert.match(io.stderr(), /orphan-token/);
  assert.match(io.stderr(), /tracked Unity operation is still RUNNING/);
  assert.match(io.stderr(), /same session/);
  assert.match(io.stderr(), /workspace resolve orphan-token --confirm/);
});

test('workspace guard forwards termination signals and still releases the lease', async () => {
  const calls = [];
  const session = new StubSession((_method, params, _options, sequence) => {
    calls.push(params.name);
    if (params.name === 'unity_router_workspace_begin') {
      return toolResponse(sequence, { structuredContent: { token: 'signal-token', project: 'A' } });
    }
    return toolResponse(sequence);
  });
  const signalEmitter = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const receivedSignals = [];
  child.kill = (signal) => {
    receivedSignals.push(signal);
    setImmediate(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    });
    return true;
  };
  const running = executeCommand(
    parseCliArgs(['workspace', 'guard', 'A', '--', '/long-running-command']),
    session,
    {
      io: captureIo().io,
      signalEmitter,
      spawnCommand() {
        setImmediate(() => signalEmitter.emit('SIGTERM'));
        return child;
      },
    },
  );

  assert.equal(await running, 1);
  assert.deepEqual(receivedSignals, ['SIGTERM']);
  assert.deepEqual(calls, ['unity_router_workspace_begin', 'unity_router_workspace_end']);
  assert.equal(signalEmitter.listenerCount('SIGTERM'), 0);
});
