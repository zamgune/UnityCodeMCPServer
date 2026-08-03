#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const stateFile = process.env.FAKE_UNITY_STATE_FILE;
const record = (kind, data = {}) => {
  if (!stateFile) return;
  appendFileSync(stateFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, kind, ...data })}\n`);
};

if (argv.includes('--version')) {
  const versionDelayMs = Math.max(0, Number(process.env.FAKE_UNITY_VERSION_DELAY_MS ?? 0));
  record('version-start', { delayMs: versionDelayMs });
  if (versionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, versionDelayMs));
  process.stdout.write(`${process.env.FAKE_UNITY_VERSION ?? '1.0.0-beta.3'}\n`);
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  record('auth-status');
  process.stdout.write('Signed in (fake)\n');
  process.exit(0);
}
if (argv[0] !== 'mcp') {
  process.stderr.write(`unsupported fake unity command: ${argv.join(' ')}\n`);
  process.exit(2);
}

const projectIndex = argv.indexOf('--project-path');
const projectPath = projectIndex >= 0 ? path.resolve(argv[projectIndex + 1]) : null;
const asyncStatusFile = stateFile
  ? `${stateFile}.${Buffer.from(projectPath ?? 'none').toString('hex').slice(-24)}.async.json`
  : null;
record('spawn', { projectPath });
if (process.env.FAKE_UNITY_IGNORE_STDIN_EOF === '1') setInterval(() => {}, 1_000);

const tools = [
  {
    name: 'editor_status',
    description: 'Fake safe read',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: { type: 'number' },
        failOnce: { type: 'string' },
        malformedFrame: { type: 'boolean' },
        exitAfterResponseMs: { type: 'number' },
        marker: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_console_logs',
    description: 'Fake console read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mutate_once',
    description: 'Fake mutation',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: { type: 'number' },
        dropAfterDispatch: { type: 'boolean' },
        notifyToolsChanged: { type: 'boolean' },
        notifyPrivate: { type: 'boolean' },
        cancelMode: { type: 'string', enum: ['silent', 'error', 'result', 'ignore'] },
        marker: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build',
    description: 'Fake tracked async build',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: { type: 'number' },
        responseDelayMs: { type: 'number' },
        marker: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_status',
    description: 'Fake tracked async build status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'recompile',
    description: 'Fake sync or tracked recompile',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['sync_success', 'async_success', 'up_to_date', 'failed', 'errors', 'missing', 'ambiguous'],
        },
        delayMs: { type: 'number' },
        notifyToolsChanged: { type: 'boolean' },
        notifyToolsChangedAfterMs: { type: 'number' },
        exitAfterToolsChangedMs: { type: 'number' },
        marker: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'recompile_status',
    description: 'Fake tracked recompile status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_tests',
    description: 'Fake tracked async tests',
    inputSchema: {
      type: 'object',
      properties: {
        async_tests: { type: 'boolean' },
        delayMs: { type: 'number' },
        marker: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'test_status',
    description: 'Fake tracked async test status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_tests',
    description: 'Fake test cancellation',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

let buffer = '';
let active = null;
let asyncTimer = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    void handle(message);
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function toolResult(id, text, structuredContent) {
  result(id, { content: [{ type: 'text', text }], structuredContent, isError: false });
}

function stateContains(kind, key) {
  if (!stateFile || !existsSync(stateFile)) return false;
  return readFileSync(stateFile, 'utf8').split('\n').some((line) => line.includes(`"kind":"${kind}"`) && line.includes(`"key":"${key}"`));
}

async function handle(message) {
  if (message.method === 'initialize') {
    const initializeDelayOnceMs = Math.max(
      0,
      Number(process.env.FAKE_UNITY_INITIALIZE_DELAY_ONCE_MS ?? 0),
    );
    if (
      initializeDelayOnceMs > 0
      && !stateContains('initialize-delay-once', projectPath)
    ) {
      record('initialize-delay-once', { key: projectPath, projectPath });
      await new Promise((resolve) => setTimeout(resolve, initializeDelayOnceMs));
    }
    result(message.id, {
      protocolVersion: process.env.FAKE_UNITY_PROTOCOL_VERSION
        ?? message.params?.protocolVersion
        ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fake-unity-mcp', version: '1' },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'notifications/cancelled') {
    record('cancel', { requestId: message.params?.requestId, reason: message.params?.reason });
    if (active?.id === message.params?.requestId) {
      if (active.cancelMode === 'ignore') return;
      const current = active;
      active = null;
      clearTimeout(current.timer);
      if (current.cancelMode === 'error') {
        send({ jsonrpc: '2.0', id: current.id, error: { code: -32800, message: 'Request cancelled' } });
      } else if (current.cancelMode === 'result') {
        toolResult(current.id, 'cancelled', { status: 'cancelled' });
      }
      current.resolve('cancelled');
    }
    return;
  }
  if (message.method === 'tools/list') {
    record('tools-list', { projectPath });
    const toolsErrorGate = process.env.FAKE_UNITY_TOOLS_ERROR_GATE_FILE;
    if (toolsErrorGate && existsSync(toolsErrorGate)) {
      record('tools-list-error', { projectPath });
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32099, message: 'Fake tools/list error' },
      });
      return;
    }
    if (
      process.env.FAKE_UNITY_MALFORMED_TOOLS_ONCE
      && !stateContains('tools-list-malformed-once', projectPath)
    ) {
      record('tools-list-malformed-once', { key: projectPath, projectPath });
      result(message.id, process.env.FAKE_UNITY_MALFORMED_TOOLS_ONCE === 'entry'
        ? { tools: [{}] }
        : {});
      return;
    }
    const toolsListDelayMs = Math.max(0, Number(process.env.FAKE_UNITY_TOOLS_LIST_DELAY_MS ?? 0));
    if (
      process.env.FAKE_UNITY_NOTIFY_DURING_TOOLS_LIST_ONCE === '1'
      && !stateContains('tools-list-notify-once', 'yes')
    ) {
      record('tools-list-notify-once', { key: 'yes', projectPath });
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
      }, Math.max(1, Math.floor(toolsListDelayMs / 3)));
    }
    if (toolsListDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, toolsListDelayMs));
    const gate = process.env.FAKE_UNITY_TOOLS_GATE_FILE;
    const catalogFile = process.env.FAKE_UNITY_TOOL_CATALOG_FILE;
    const catalogVersion = catalogFile && existsSync(catalogFile)
      ? readFileSync(catalogFile, 'utf8').trim()
      : '';
    const listedTools = catalogVersion
      ? tools.map((tool) => tool.name === 'editor_status'
        ? { ...tool, description: `Fake safe read ${catalogVersion}` }
        : tool)
      : tools;
    result(message.id, { tools: gate && !existsSync(gate) ? [] : listedTools });
    return;
  }
  if (
    message.method === 'resources/list'
    || message.method === 'resources/templates/list'
    || message.method === 'prompts/list'
  ) {
    const params = message.params ?? {};
    if (params.failOnce && !stateContains('protocol-fail-once', params.failOnce)) {
      record('protocol-fail-once', { key: params.failOnce, method: message.method, projectPath });
      process.exit(13);
    }
    record('protocol-start', { id: message.id, method: message.method, projectPath, marker: params.marker });
    if (Number(params.delayMs) > 0) {
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('completed'), Number(params.delayMs));
        active = { id: message.id, timer, resolve, cancelMode: params.cancelMode ?? 'error' };
      });
      if (active?.id === message.id) active = null;
      if (outcome === 'cancelled') return;
    }
    record('protocol-end', { id: message.id, method: message.method, projectPath, marker: params.marker });
    if (message.method === 'resources/list') result(message.id, { resources: [] });
    else if (message.method === 'resources/templates/list') result(message.id, { resourceTemplates: [] });
    else result(message.id, { prompts: [] });
    return;
  }
  if (message.method !== 'tools/call') {
    result(message.id, {});
    return;
  }

  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  record('call-start', { id: message.id, name, projectPath, marker: args.marker });
  if (args.malformedFrame) {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (name === 'build_status' || name === 'test_status' || name === 'recompile_status') {
    const status = asyncStatusFile && existsSync(asyncStatusFile)
      ? JSON.parse(readFileSync(asyncStatusFile, 'utf8'))
      : { status: 'idle' };
    record('call-end', { id: message.id, name, projectPath, status: status.status });
    toolResult(message.id, JSON.stringify(status), status);
    const terminalNotifyMs = Number(process.env.FAKE_UNITY_NOTIFY_AFTER_TERMINAL_STATUS_MS ?? 0);
    if (
      name === 'recompile_status'
      && status.status === 'completed'
      && terminalNotifyMs > 0
      && !stateContains('terminal-status-notify-scheduled', 'recompile')
    ) {
      record('terminal-status-notify-scheduled', { key: 'recompile', projectPath });
      setTimeout(() => {
        record('tools-list-changed-notify', { phase: 'recovered-async-late', projectPath });
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
      }, terminalNotifyMs);
    }
    return;
  }
  if (name === 'recompile') {
    const mode = args.mode ?? 'sync_success';
    const success = { status: 'completed', failed: false, errors: [], isCompiling: false };
    if (mode === 'async_success') {
      const delayMs = Math.max(25, Number(args.delayMs ?? 250));
      const activeStatus = { status: 'compiling', failed: false, errors: [], isCompiling: true };
      if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify(activeStatus));
      asyncTimer = setTimeout(() => {
        if (args.notifyToolsChanged) {
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
        }
        if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify(success));
        record('async-complete', { name, projectPath, marker: args.marker });
        if (Number.isFinite(args.notifyToolsChangedAfterMs)) {
          setTimeout(() => {
            record('tools-list-changed-notify', { phase: 'async-late', marker: args.marker, projectPath });
            send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
            if (Number.isFinite(args.exitAfterToolsChangedMs)) {
              setTimeout(() => process.exit(44), Math.max(0, Number(args.exitAfterToolsChangedMs)));
            }
          }, Math.max(0, Number(args.notifyToolsChangedAfterMs)));
        }
      }, delayMs);
      const triggered = { status: 'triggered', failed: false, errors: [], isCompiling: true };
      record('call-end', { id: message.id, name, projectPath, marker: args.marker, status: triggered.status });
      toolResult(message.id, JSON.stringify(triggered), triggered);
      return;
    }

    const payload = mode === 'up_to_date'
      ? { status: 'up_to_date', failed: false, errors: [], isCompiling: false }
      : mode === 'failed'
        ? { status: 'completed', failed: true, errors: [], isCompiling: false }
        : mode === 'errors'
          ? { status: 'completed', failed: false, errors: ['Compiler error'], isCompiling: false }
          : mode === 'missing'
            ? { failed: false, errors: [], isCompiling: false }
            : success;
    if (args.notifyToolsChanged) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    }
    record('call-end', { id: message.id, name, projectPath, marker: args.marker, status: payload.status });
    if (mode === 'ambiguous') {
      result(message.id, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'failed', failed: true, errors: ['conflict'] }) }],
        structuredContent: success,
        isError: false,
      });
    } else {
      // Text-only mirrors the beta.3 synchronous-final response. The broker's
      // parser must not depend on the compat shim's structuredContent.
      result(message.id, { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
    }
    if (Number.isFinite(args.notifyToolsChangedAfterMs)) {
      setTimeout(() => {
        record('tools-list-changed-notify', { phase: 'sync-late', marker: args.marker, projectPath });
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
        if (Number.isFinite(args.exitAfterToolsChangedMs)) {
          setTimeout(() => process.exit(44), Math.max(0, Number(args.exitAfterToolsChangedMs)));
        }
      }, Math.max(0, Number(args.notifyToolsChangedAfterMs)));
    }
    return;
  }
  if (name === 'build') {
    const delayMs = Math.max(25, Number(args.delayMs ?? 250));
    const queued = { status: 'queued', buildId: `fake-${Date.now()}` };
    if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify({ ...queued, status: 'building' }));
    asyncTimer = setTimeout(() => {
      if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify({ ...queued, status: 'completed', result: 'Succeeded' }));
      record('async-complete', { name, projectPath, marker: args.marker });
    }, delayMs);
    if (Number(args.responseDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(args.responseDelayMs)));
    }
    record('call-end', { id: message.id, name, projectPath, marker: args.marker });
    toolResult(message.id, JSON.stringify(queued), queued);
    return;
  }
  if (name === 'run_tests') {
    const delayMs = Math.max(25, Number(args.delayMs ?? 250));
    const running = { status: 'running' };
    if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify(running));
    asyncTimer = setTimeout(() => {
      if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify({ status: 'completed', result: 'Passed' }));
      record('async-complete', { name, projectPath, marker: args.marker });
    }, delayMs);
    record('call-end', { id: message.id, name, projectPath, marker: args.marker });
    toolResult(message.id, JSON.stringify(running), running);
    return;
  }
  if (name === 'cancel_tests') {
    if (asyncTimer) clearTimeout(asyncTimer);
    asyncTimer = null;
    const cancelled = { status: 'cancelled' };
    if (asyncStatusFile) writeFileSync(asyncStatusFile, JSON.stringify(cancelled));
    record('call-end', { id: message.id, name, projectPath });
    toolResult(message.id, JSON.stringify(cancelled), cancelled);
    return;
  }
  if (name === 'editor_status' && args.failOnce && !stateContains('fail-once', args.failOnce)) {
    record('fail-once', { key: args.failOnce, name, projectPath });
    process.exit(41);
  }
  if (name === 'mutate_once') {
    record('mutation', { name, projectPath, marker: args.marker });
    if (args.dropAfterDispatch) process.exit(42);
  }

  const delayMs = Math.max(0, Number(args.delayMs ?? 0));
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('completed'), delayMs);
    active = { id: message.id, timer, resolve, cancelMode: args.cancelMode ?? 'silent' };
  });
  if (active?.id === message.id) active = null;
  if (outcome === 'cancelled') return;
  record('call-end', { id: message.id, name, projectPath, marker: args.marker });
  if (args.notifyToolsChanged) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
  if (args.notifyPrivate) {
    send({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: `private:${args.marker ?? 'none'}` },
    });
  }
  toolResult(message.id, `${name} ok for ${projectPath}`, { name, projectPath, pid: process.pid });
  if (Number.isFinite(args.exitAfterResponseMs)) {
    setTimeout(() => process.exit(43), Math.max(0, Number(args.exitAfterResponseMs)));
  }
}
