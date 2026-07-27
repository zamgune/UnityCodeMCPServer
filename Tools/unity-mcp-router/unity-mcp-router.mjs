#!/usr/bin/env node
/**
 * unity-mcp-router
 *
 * A thin stdio MCP proxy in front of Unity's official `unity mcp` server.
 *
 * Why this exists
 * ---------------
 * `unity mcp` is already a stdio MCP server, so transport was never the problem.
 * The problem is process lifetime: the server reads the Unity Cloud token that
 * `unity auth login` cached, holds it for the life of the process, and starts
 * returning `401 Unauthorized` once that token expires. MCP clients (Codex
 * included) cannot restart a server mid-session, so the session stays dead --
 * "the official Unity connection process was not recreated".
 *
 * This router owns the child process instead. It:
 *   - spawns `unity mcp --project-path <path>` lazily, one child per project;
 *   - forwards JSON-RPC transparently, so tool schemas stay Unity's own;
 *   - adds an optional `project` argument to every tool so one registered
 *     server can drive several Unity projects;
 *   - detects 401/auth failures, refreshes the CLI token, restarts the child
 *     and retries the call once -- invisibly to the client;
 *   - detects "no Editor connected" and probes with `unity command` before
 *     returning an actionable message instead of a raw stack trace;
 *   - keeps the cached token warm with a periodic `unity auth status`.
 *
 * Zero dependencies. Node 18+.
 */

import { spawn, execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_CONFIG_PATH = path.join(HERE, 'unity-mcp-router.config.json');

function parseArgv(argv) {
  const out = { projects: [], config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--config') out.config = next();
    else if (a === '--unity') out.unityBin = next();
    else if (a === '--default') out.defaultProject = next();
    else if (a === '--project') {
      // --project name=/abs/path
      const raw = next() ?? '';
      const eq = raw.indexOf('=');
      if (eq > 0) out.projects.push({ name: raw.slice(0, eq), path: raw.slice(eq + 1) });
    } else if (a === '--log') out.logFile = next();
    else if (a === '--tool-timeout-sec') out.toolTimeoutSec = Number(next());
    else if (a === '--startup-timeout-sec') out.startupTimeoutSec = Number(next());
    else if (a === '--reauth-interval-min') out.reauthIntervalMin = Number(next());
    else if (a === '--max-retries') out.maxRetries = Number(next());
  }
  return out;
}

function loadConfig() {
  const cli = parseArgv(process.argv.slice(2));
  const configPath = cli.config ?? DEFAULT_CONFIG_PATH;
  let file = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      // Cannot log yet; surface on stderr, which MCP clients treat as diagnostics.
      process.stderr.write(`unity-mcp-router: bad config at ${configPath}: ${err.message}\n`);
    }
  }

  const envProjects = [];
  if (process.env.UNITY_MCP_PROJECTS) {
    for (const pair of process.env.UNITY_MCP_PROJECTS.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) envProjects.push({ name: pair.slice(0, eq).trim(), path: pair.slice(eq + 1).trim() });
    }
  }

  const projects = [...(file.projects ?? []), ...envProjects, ...cli.projects]
    .filter((p) => p && p.name && p.path)
    .map((p) => ({ name: String(p.name), path: path.resolve(String(p.path)), extraArgs: p.extraArgs ?? [] }));

  // Later entries win on duplicate names.
  const byName = new Map();
  for (const p of projects) byName.set(p.name, p);
  const list = [...byName.values()];

  return {
    unityBin: cli.unityBin ?? process.env.UNITY_BIN ?? file.unityBin ?? 'unity',
    projects: list,
    defaultProject: cli.defaultProject ?? process.env.UNITY_MCP_DEFAULT ?? file.defaultProject ?? list[0]?.name,
    logFile: cli.logFile ?? file.logFile ?? path.join(homedir(), '.unity-mcp-router', 'router.log'),
    toolTimeoutSec: cli.toolTimeoutSec ?? file.toolTimeoutSec ?? 300,
    startupTimeoutSec: cli.startupTimeoutSec ?? file.startupTimeoutSec ?? 60,
    reauthIntervalMin: cli.reauthIntervalMin ?? file.reauthIntervalMin ?? 20,
    maxRetries: cli.maxRetries ?? file.maxRetries ?? 1,
  };
}

const CONFIG = loadConfig();

// ---------------------------------------------------------------------------
// Logging (file only -- stdout is reserved for JSON-RPC)
// ---------------------------------------------------------------------------

let logStream = null;
try {
  mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
  logStream = createWriteStream(CONFIG.logFile, { flags: 'a' });
} catch {
  logStream = null;
}

function log(level, msg, extra) {
  if (!logStream) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
  try {
    logStream.write(JSON.stringify(line) + '\n');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const AUTH_PATTERNS = [
  /\b401\b/,
  /unauthori[sz]ed/i,
  /unauthenticated/i,
  /not\s+(?:signed|logged)\s+in/i,
  /invalid[\s_-]?token/i,
  /token\s+(?:has\s+)?expired/i,
  /expired[\s_-]?(?:access[\s_-]?)?token/i,
  /session\s+(?:is\s+)?(?:invalid|expired)/i,
  /\b403\b.*\b(?:auth|token|credential)/i,
];

const EDITOR_PATTERNS = [
  /no\s+(?:running\s+)?(?:unity\s+)?editor/i,
  /editor\s+(?:is\s+)?not\s+(?:connected|running|available|ready|found)/i,
  /not\s+connected\s+to\s+(?:the\s+)?editor/i,
  /could\s+not\s+(?:connect|discover)/i,
  /connection\s+(?:refused|reset|closed)/i,
  /ECONNREFUSED|ECONNRESET|EPIPE/,
  /pipeline\s+(?:package\s+)?not\s+(?:installed|found)/i,
  /no\s+pipeline\s+instance/i,
  /make\s+sure\s+.*editor\s+is\s+running/i,
  /failed\s+to\s+(?:reach|attach\s+to)\s+.*editor/i,
];

// Real messages seen from `unity mcp` / `unity command`, asserted by --self-check.
const CLASSIFY_SAMPLES = [
  ['No Pipeline instance found for project: /p. Make sure Unity Editor is running with the Pipeline package installed.', 'editor'],
  ['connect ECONNREFUSED 127.0.0.1:9002', 'editor'],
  ['Unity Editor is not connected', 'editor'],
  ['Request failed with status code 401 Unauthorized', 'auth'],
  ['The access token has expired', 'auth'],
  ['Compilation failed: CS1002 expected ;', null],
];

function selfCheck() {
  let failed = 0;
  for (const [message, want] of CLASSIFY_SAMPLES) {
    const got = classifyFailure({ result: { isError: true, content: [{ type: 'text', text: message }] } });
    if (got !== want) {
      failed++;
      process.stdout.write(`FAIL want=${want} got=${got}: ${message}\n`);
    }
  }
  process.stdout.write(failed ? `\n${failed} failed\n` : `classifyFailure: ${CLASSIFY_SAMPLES.length} ok\n`);
  process.exit(failed ? 1 : 0);
}

function textOf(payload) {
  const parts = [];
  const walk = (v, depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(payload);
  return parts.join('\n');
}

/** Returns 'auth' | 'editor' | null for a JSON-RPC response we should recover from. */
function classifyFailure(response) {
  if (!response) return null;
  const isErrorResult = response.result && response.result.isError === true;
  if (!response.error && !isErrorResult) return null;
  const blob = textOf(response.error ?? response.result);
  if (AUTH_PATTERNS.some((re) => re.test(blob))) return 'auth';
  if (EDITOR_PATTERNS.some((re) => re.test(blob))) return 'editor';
  return null;
}

// ---------------------------------------------------------------------------
// Unity CLI helpers
// ---------------------------------------------------------------------------

function runUnity(args, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    execFile(
      CONFIG.unityBin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/**
 * Touch the CLI's cached credential. A fresh `unity auth status` process reads
 * (and, where the CLI supports it, silently refreshes) the stored token. The
 * long-lived `unity mcp` child does not do this on its own, which is the whole
 * reason 401s appear mid-session.
 */
async function refreshAuth() {
  const res = await runUnity(['auth', 'status'], 30_000);
  const blob = `${res.stdout}\n${res.stderr}`;
  const signedIn = res.ok && !/not\s+(?:signed|logged)\s+in/i.test(blob);
  log('info', 'auth status probed', { ok: res.ok, signedIn, out: blob.trim().slice(0, 400) });
  return { signedIn, raw: blob.trim() };
}

async function probeEditor(projectPath) {
  const res = await runUnity(['command', '--project-path', projectPath], 30_000);
  log('info', 'editor probed', { projectPath, ok: res.ok });
  return { ok: res.ok, raw: `${res.stdout}\n${res.stderr}`.trim() };
}

// ---------------------------------------------------------------------------
// Child: one `unity mcp` process per project
// ---------------------------------------------------------------------------

class UnityChild {
  constructor(project) {
    this.project = project;
    this.proc = null;
    this.buffer = '';
    this.pending = new Map(); // childId -> {resolve, timer}
    this.nextId = 1;
    this.ready = false;
    this.startedAt = 0;
    this.startPromise = null;
    this.serverInfo = null;
  }

  get alive() {
    return this.proc != null && this.proc.exitCode == null && !this.proc.killed;
  }

  async start(protocolVersion, clientInfo) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start(protocolVersion, clientInfo).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start(protocolVersion, clientInfo) {
    const args = ['mcp', '--project-path', this.project.path, ...(this.project.extraArgs ?? [])];
    log('info', 'spawning child', { project: this.project.name, bin: CONFIG.unityBin, args });

    this.proc = spawn(CONFIG.unityBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.startedAt = Date.now();
    this.buffer = '';

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) =>
      log('debug', 'child stderr', { project: this.project.name, chunk: String(chunk).slice(0, 2000) }),
    );

    this.proc.on('exit', (code, signal) => {
      log('warn', 'child exited', { project: this.project.name, code, signal });
      this.ready = false;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ error: { code: -32000, message: `unity mcp exited (code=${code} signal=${signal})` } });
      }
      this.pending.clear();
    });

    this.proc.on('error', (err) => {
      log('error', 'child spawn error', { project: this.project.name, message: err.message });
      this.ready = false;
    });

    // MCP handshake with the child.
    const init = await this.request(
      {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: protocolVersion ?? '2025-06-18',
          capabilities: {},
          clientInfo: clientInfo ?? { name: 'unity-mcp-router', version: '1.0.0' },
        },
      },
      CONFIG.startupTimeoutSec * 1000,
    );

    if (init.error) {
      throw new Error(`initialize failed for ${this.project.name}: ${JSON.stringify(init.error)}`);
    }

    this.serverInfo = init.result?.serverInfo ?? null;
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true;
    log('info', 'child ready', { project: this.project.name, serverInfo: this.serverInfo });
    return init.result;
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('warn', 'unparseable child line', { project: this.project.name, line: line.slice(0, 500) });
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      } else {
        // Server-initiated notification/request. Forward notifications upward.
        if (msg.id == null) writeOut(msg);
        else log('debug', 'unmatched child response', { project: this.project.name, id: msg.id });
      }
    }
  }

  send(msg) {
    if (!this.alive) return false;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      log('error', 'child write failed', { project: this.project.name, message: err.message });
      return false;
    }
  }

  request(msg, timeoutMs) {
    const id = `r${this.nextId++}`;
    const payload = { ...msg, id };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          error: {
            code: -32001,
            message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${msg.method} on project "${this.project.name}".`,
          },
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      if (!this.send(payload)) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { code: -32000, message: `unity mcp process for "${this.project.name}" is not running.` } });
      }
    });
  }

  async stop() {
    this.ready = false;
    if (!this.alive) return;
    const proc = this.proc;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Router state
// ---------------------------------------------------------------------------

const children = new Map(); // project name -> UnityChild
let clientProtocolVersion = '2025-06-18';
let clientInfo = { name: 'unknown', version: '0' };
let cachedTools = null;

function projectByName(name) {
  return CONFIG.projects.find((p) => p.name === name);
}

async function getChild(name, { restart = false } = {}) {
  const project = projectByName(name);
  if (!project) throw new Error(`Unknown project "${name}". Configured: ${CONFIG.projects.map((p) => p.name).join(', ') || '(none)'}`);

  let child = children.get(name);
  if (child && restart) {
    await child.stop();
    children.delete(name);
    child = null;
  }
  if (child && child.alive && child.ready) return child;
  if (child && !child.alive) children.delete(name);

  child = children.get(name) ?? new UnityChild(project);
  children.set(name, child);
  if (!child.ready) await child.start(clientProtocolVersion, clientInfo);
  return child;
}

// ---------------------------------------------------------------------------
// Router-native tools
// ---------------------------------------------------------------------------

const PROJECT_NAMES = () => CONFIG.projects.map((p) => p.name);

const ROUTER_TOOLS = [
  {
    name: 'unity_router_status',
    description:
      'Report the router state: configured Unity projects, whether each `unity mcp` child is running, the Unity CLI version, and the current `unity auth status`. Use this first when a Unity tool starts failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'unity_router_restart',
    description:
      'Force-restart the `unity mcp` child process for a project, refreshing its Unity Cloud token. The router already does this automatically on a 401, so only call it manually when a session is visibly stuck.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name. Defaults to the configured default project.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'unity_auth_refresh',
    description:
      'Run `unity auth status` to refresh the cached Unity Cloud credential and report whether an interactive `unity auth login` is required.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function callRouterTool(name, args) {
  if (name === 'unity_auth_refresh') {
    const auth = await refreshAuth();
    return toolResult(
      auth.signedIn
        ? `Unity CLI credential refreshed and valid.\n\n${auth.raw}`
        : `Not signed in. Run \`unity auth login\` in a terminal, then retry.\n\n${auth.raw}`,
      !auth.signedIn,
    );
  }

  if (name === 'unity_router_restart') {
    const target = args?.project ?? CONFIG.defaultProject;
    try {
      await getChild(target, { restart: true });
      return toolResult(`Restarted \`unity mcp\` for "${target}".`);
    } catch (err) {
      return toolResult(`Failed to restart "${target}": ${err.message}`, true);
    }
  }

  if (name === 'unity_router_status') {
    const version = await runUnity(['--version'], 15_000);
    const auth = await refreshAuth();
    const rows = CONFIG.projects.map((p) => {
      const c = children.get(p.name);
      const state = !c ? 'not started' : c.alive && c.ready ? 'ready' : c.alive ? 'starting' : 'exited';
      const age = c?.startedAt ? `${Math.round((Date.now() - c.startedAt) / 60000)}m` : '-';
      return `  ${p.name === CONFIG.defaultProject ? '*' : ' '} ${p.name.padEnd(22)} ${state.padEnd(12)} uptime=${age}  ${p.path}`;
    });
    return toolResult(
      [
        `unity binary : ${CONFIG.unityBin}`,
        `unity version: ${(version.stdout || version.stderr).trim() || 'unknown'}`,
        `signed in    : ${auth.signedIn ? 'yes' : 'NO -- run `unity auth login`'}`,
        `log file     : ${CONFIG.logFile}`,
        '',
        'projects (* = default):',
        ...rows,
      ].join('\n'),
    );
  }

  return toolResult(`Unknown router tool "${name}".`, true);
}

// ---------------------------------------------------------------------------
// Tool list: inject the `project` argument
// ---------------------------------------------------------------------------

function decorateTools(tools) {
  const names = PROJECT_NAMES();
  return tools.map((tool) => {
    const schema = tool.inputSchema ? structuredClone(tool.inputSchema) : { type: 'object', properties: {} };
    if (schema.type !== 'object') return tool;
    schema.properties = schema.properties ?? {};
    if (!schema.properties.project) {
      schema.properties.project = {
        type: 'string',
        ...(names.length ? { enum: names } : {}),
        description: `Which Unity project to target. Defaults to "${CONFIG.defaultProject}". The Editor for that project must be open.`,
      };
    }
    // `project` is router metadata, never forwarded, so a strict child schema
    // must not reject it here.
    if (schema.additionalProperties === false) delete schema.additionalProperties;
    return { ...tool, inputSchema: schema };
  });
}

async function listTools() {
  if (cachedTools) return cachedTools;
  const child = await getChild(CONFIG.defaultProject);
  const res = await child.request({ jsonrpc: '2.0', method: 'tools/list', params: {} }, CONFIG.startupTimeoutSec * 1000);
  if (res.error) throw new Error(JSON.stringify(res.error));
  const tools = decorateTools(res.result?.tools ?? []);
  const list = { tools: [...tools, ...ROUTER_TOOLS] };
  // `unity mcp` starts fine with no Editor attached and answers with zero Unity tools. Caching that
  // would leave the client session holding only the router's own tools for as long as it runs.
  cachedTools = tools.length ? list : null;
  return list;
}

/** Re-list after the Editor may have come up, and tell the client if the Unity tools appeared. */
async function refreshToolsIfEmpty() {
  if (cachedTools) return;
  try {
    const list = await listTools();
    if (list.tools.length > ROUTER_TOOLS.length) {
      log('info', 'unity tools became available', { count: list.tools.length });
      writeOut({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    }
  } catch (err) {
    log('debug', 'tool list still unavailable', { message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Recovery-wrapped tool call
// ---------------------------------------------------------------------------

async function callToolWithRecovery(projectName, params) {
  const timeoutMs = CONFIG.toolTimeoutSec * 1000;
  let attempt = 0;

  for (;;) {
    let child;
    try {
      child = await getChild(projectName, { restart: attempt > 0 });
    } catch (err) {
      return { result: toolResult(err.message, true) };
    }

    const res = await child.request({ jsonrpc: '2.0', method: 'tools/call', params }, timeoutMs);
    const failure = classifyFailure(res);

    if (!failure || attempt >= CONFIG.maxRetries) {
      if (failure === 'auth' && attempt >= CONFIG.maxRetries) {
        const auth = await refreshAuth();
        if (!auth.signedIn) {
          return {
            result: toolResult(
              `Unity Cloud session is invalid and could not be refreshed automatically.\n\n` +
                `Run this in a terminal, then retry the tool:\n  unity auth login\n\n` +
                `\`unity auth status\` said:\n${auth.raw}`,
              true,
            ),
          };
        }
      }
      if (failure === 'editor' && attempt >= CONFIG.maxRetries) {
        const project = projectByName(projectName);
        const probe = await probeEditor(project.path);
        if (!probe.ok) {
          return {
            result: toolResult(
              `No Unity Editor is reachable for "${projectName}".\n\n` +
                `Checklist:\n` +
                `  1. Open the project in Unity 6: unity open "${project.path}"\n` +
                `  2. Wait until compilation finishes (no spinner in the bottom-right).\n` +
                `  3. Confirm the Pipeline package: unity pipeline list --project-path "${project.path}"\n` +
                `  4. Confirm the command surface: unity command --project-path "${project.path}"\n\n` +
                `\`unity command\` said:\n${probe.raw.slice(0, 1500)}`,
              true,
            ),
          };
        }
      }
      return res;
    }

    attempt++;
    log('warn', 'recovering from failure', { project: projectName, failure, attempt, tool: params?.name });

    if (failure === 'auth') {
      const auth = await refreshAuth();
      if (!auth.signedIn) {
        return {
          result: toolResult(
            `Unity Cloud session expired and you are signed out.\n\nRun:\n  unity auth login\n\nThen retry. ` +
              `The router will restart \`unity mcp\` for "${projectName}" automatically on the next call.`,
            true,
          ),
        };
      }
    } else {
      const project = projectByName(projectName);
      await probeEditor(project.path);
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Loop: next iteration restarts the child and retries once.
  }
}

// ---------------------------------------------------------------------------
// Client-facing stdio loop
// ---------------------------------------------------------------------------

function writeOut(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    log('error', 'stdout write failed', { message: err.message });
  }
}

function reply(id, result) {
  writeOut({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  writeOut({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications: nothing to answer.
  if (id == null) {
    if (method === 'notifications/initialized') return;
    if (method === 'notifications/cancelled') return;
    return;
  }

  try {
    switch (method) {
      case 'initialize': {
        clientProtocolVersion = params?.protocolVersion ?? clientProtocolVersion;
        clientInfo = params?.clientInfo ?? clientInfo;
        log('info', 'client initialize', { clientInfo, clientProtocolVersion, projects: PROJECT_NAMES() });
        reply(id, {
          protocolVersion: clientProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'unity-mcp-router', version: '1.0.0' },
          instructions:
            `Proxy in front of Unity's official \`unity mcp\` server.\n\n` +
            `Every tool accepts an optional "project" argument: ${PROJECT_NAMES().join(', ') || '(none configured)'} ` +
            `(default: ${CONFIG.defaultProject}). The target project's Unity Editor must be open and done compiling.\n\n` +
            `If a call fails with 401/Unauthorized the router refreshes the Unity credential, restarts the ` +
            `underlying server and retries once -- do not ask the user to restart the MCP session. ` +
            `Call unity_router_status to inspect state.`,
        });
        return;
      }

      case 'ping':
        reply(id, {});
        return;

      case 'tools/list': {
        const list = await listTools();
        reply(id, list);
        return;
      }

      case 'tools/call': {
        const toolName = params?.name;
        const args = { ...(params?.arguments ?? {}) };
        const requested = args.project;
        delete args.project;

        if (ROUTER_TOOLS.some((t) => t.name === toolName)) {
          reply(id, await callRouterTool(toolName, params?.arguments ?? {}));
          // A stuck client calls a router tool first; use that as the cue to re-check the Editor.
          refreshToolsIfEmpty();
          return;
        }

        const target = requested ?? CONFIG.defaultProject;
        if (!projectByName(target)) {
          reply(
            id,
            toolResult(
              `Unknown project "${target}". Configured projects: ${PROJECT_NAMES().join(', ') || '(none)'}. ` +
                `Add it to unity-mcp-router.config.json.`,
              true,
            ),
          );
          return;
        }

        const res = await callToolWithRecovery(target, { ...params, arguments: args });
        if (res.error) replyError(id, res.error.code ?? -32000, res.error.message ?? 'Unity call failed');
        else reply(id, res.result);
        return;
      }

      case 'resources/list':
      case 'resources/templates/list':
      case 'prompts/list': {
        // Forward, but degrade gracefully if the child does not implement them.
        try {
          const child = await getChild(CONFIG.defaultProject);
          const res = await child.request({ jsonrpc: '2.0', method, params }, CONFIG.startupTimeoutSec * 1000);
          if (res.error) {
            const empty = method === 'prompts/list' ? { prompts: [] } : method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] };
            reply(id, empty);
          } else reply(id, res.result);
        } catch {
          reply(id, method === 'prompts/list' ? { prompts: [] } : { resources: [] });
        }
        return;
      }

      default: {
        const child = await getChild(CONFIG.defaultProject);
        const res = await child.request({ jsonrpc: '2.0', method, params }, CONFIG.toolTimeoutSec * 1000);
        if (res.error) replyError(id, res.error.code ?? -32000, res.error.message ?? 'Unity call failed');
        else reply(id, res.result);
        return;
      }
    }
  } catch (err) {
    log('error', 'handler threw', { method, message: err?.message, stack: err?.stack });
    replyError(id, -32000, err?.message ?? String(err));
  }
}

// ---- stdin framing -------------------------------------------------------

if (process.argv.includes('--self-check')) selfCheck();

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let idx;
  while ((idx = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, idx).trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('warn', 'unparseable client line', { line: line.slice(0, 500) });
      continue;
    }
    handleMessage(msg);
  }
});

process.stdin.on('end', () => shutdown(0));

// ---- keep the cached Unity credential warm -------------------------------

if (CONFIG.reauthIntervalMin > 0) {
  const timer = setInterval(() => {
    refreshAuth().catch(() => {});
    refreshToolsIfEmpty();
  }, CONFIG.reauthIntervalMin * 60_000);
  timer.unref();
}

// ---- shutdown ------------------------------------------------------------

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'router shutting down', { code });
  await Promise.all([...children.values()].map((c) => c.stop().catch(() => {})));
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  log('error', 'uncaught exception', { message: err?.message, stack: err?.stack });
});
process.on('unhandledRejection', (err) => {
  log('error', 'unhandled rejection', { message: err?.message ?? String(err) });
});

log('info', 'router started', {
  unityBin: CONFIG.unityBin,
  projects: CONFIG.projects,
  defaultProject: CONFIG.defaultProject,
});
