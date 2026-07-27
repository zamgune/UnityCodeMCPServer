#!/usr/bin/env node
// One-shot CLI for unity-mcp-router. No MCP client, no tool timeout, any agent can shell out.
//
//   node router-cli.mjs smoke [Project]              verify router + Editor, exit 1 on failure
//   node router-cli.mjs list                         list available tools
//   node router-cli.mjs call <tool> [jsonArgs] [--project X] [--json]
//
// The target project's Unity Editor must be open and done compiling.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv.splice(i, 2)[1] ?? '';
};
const has = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? false : (argv.splice(i, 1), true);
};

const raw = has('--json');
const projectFlag = flag('--project');
const [cmd = 'smoke', ...rest] = argv;
// `smoke SheepWolf` is the shorthand for `smoke --project SheepWolf`
const project = projectFlag || (cmd === 'smoke' ? rest[0] : null) || null;

// ---- router session -------------------------------------------------------
const routerArgs = [path.join(HERE, 'unity-mcp-router.mjs')];
// tools/list is answered by the default project's child, so point the router at --project too
if (project) routerArgs.push('--default', project);
const proc = spawn(process.execPath, routerArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let buf = '';
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});
proc.on('exit', (code) => {
  for (const resolve of pending.values()) resolve({ error: { message: `router exited (${code})` } });
  pending.clear();
});

let nextId = 1;
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  // ponytail: 310s > the router's own 300s tool timeout, so the router's error wins the race
  const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 310_000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const text = (res) => (res.result?.content ?? []).map((c) => c.text ?? '').join('\n');

async function call(name, args) {
  const res = await send('tools/call', { name, arguments: args });
  if (res.error) return { ok: false, out: `error: ${res.error.message}` };
  const body = raw ? JSON.stringify(res.result, null, 2) : (text(res) || JSON.stringify(res.result));
  return { ok: !res.result?.isError, out: body };
}

// ---- commands -------------------------------------------------------------
async function run() {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'router-cli', version: '1' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  if (cmd === 'list') {
    const res = await send('tools/list', {});
    if (res.error) { console.error(res.error.message); return false; }
    if (raw) console.log(JSON.stringify(res.result, null, 2));
    else for (const t of res.result.tools) console.log(`${t.name}\t${(t.description || '').split('\n')[0]}`);
    return true;
  }

  if (cmd === 'call') {
    const [tool, json] = rest;
    if (!tool) { console.error('usage: router-cli.mjs call <tool> [jsonArgs] [--project X]'); return false; }
    const args = json ? JSON.parse(json) : {};
    if (project) args.project = project;
    const { ok, out } = await call(tool, args);
    console.log(out);
    return ok;
  }

  if (cmd === 'smoke') {
    let ok = true;
    for (const [tool, args] of [['unity_router_status', {}], ['editor_status', project ? { project } : {}]]) {
      console.log(`\n── ${tool}${args.project ? ` (${args.project})` : ''}`);
      const r = await call(tool, args);
      console.log(r.out.slice(0, 2000));
      ok = ok && r.ok;
    }
    return ok;
  }

  console.error(`unknown command: ${cmd}`);
  return false;
}

let ok = false;
try {
  ok = await run();
} catch (err) {
  console.error(err.message);
}
proc.stdin.end();
if (cmd === 'smoke') console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
