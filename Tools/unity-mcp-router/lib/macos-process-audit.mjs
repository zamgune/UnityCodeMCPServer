import { execFile } from 'node:child_process';
import path from 'node:path';

export const PROCESS_AUDIT_TIMEOUT_MS = 2_000;
const PROCESS_AUDIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function parseProcessTable(text) {
  const processes = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return processes;
}

function projectArgument(command) {
  const match = command.match(/(?:--project-path|-projectpath)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3];
  // Process auditing runs in the broker. Never dereference a configured or
  // observed external-volume path here: a stalled mount could otherwise hang
  // status/doctor before the bounded project-access helper gets a chance to
  // classify it.
  return path.resolve(value);
}

function commandWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaping = false;
  for (const char of String(command ?? '')) {
    if (escaping) {
      word += char;
      escaping = false;
    } else if (char === '\\' && quote !== "'") {
      escaping = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = '';
      }
    } else {
      word += char;
    }
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

function isUnityMcp(command) {
  const words = commandWords(command);
  return executableName(words).toLowerCase() === 'unity' && unitySubcommand(words) === 'mcp';
}

function isUnityEditor(command) {
  const words = commandWords(command);
  return /Unity\.app\/Contents\/MacOS\/Unity$/.test(words[0] ?? '');
}

function isBeeBackend(command) {
  const executable = executableName(commandWords(command)).toLowerCase();
  return executable === 'bee_backend' || executable === 'bee_backend.exe';
}

function isBrokerDaemon(command) {
  const words = commandWords(command);
  return path.basename(nodeScript(words) ?? '') === 'broker-daemon.mjs' ||
    executableName(words) === 'broker-daemon.mjs';
}

function isRouterAdapter(command) {
  const words = commandWords(command);
  const executable = executableName(words);
  const script = path.basename(nodeScript(words) ?? '');
  if (script === 'unity-mcp-router.mjs' || executable === 'unity-mcp-router.mjs') return true;
  if (executable === 'unity-code-mcp-stdio') return true;
  return executable === 'uv' && words.includes('unity-code-mcp-stdio');
}

// Asset import workers reuse the Editor executable and repeat -projectPath,
// but they are helper children of one Editor session rather than additional
// routable Editors or licence seats. Counting them would make every normally
// importing project look like a duplicate-Editor violation.
function isUnityEditorHelper(command) {
  return /(?:^|\s)-adb2(?:\s|$)/.test(command) ||
    /(?:^|\s)-name(?:\s+|=)(?:"|')?(?:AssetImportWorker\d*|AssetImport)(?:"|'|\s|$)/i.test(command);
}

function findAncestorEditorPid(proc, processByPid, editorPids) {
  const visited = new Set([proc.pid]);
  let ancestorPid = proc.ppid;
  while (Number.isSafeInteger(ancestorPid) && ancestorPid > 0 && !visited.has(ancestorPid)) {
    if (editorPids.has(ancestorPid)) return ancestorPid;
    visited.add(ancestorPid);
    const ancestor = processByPid.get(ancestorPid);
    if (!ancestor) break;
    ancestorPid = ancestor.ppid;
  }
  return null;
}

export function auditProcessTable(processes, {
  brokerPid = process.pid,
  childPids = [],
  adapterPids = [],
  configuredProjectPaths = [],
  maxConcurrentEditors = 1,
} = {}) {
  const managedChildren = new Set(childPids.filter(Number.isSafeInteger));
  const managedAdapters = new Set(adapterPids.filter(Number.isSafeInteger));
  const configured = new Set(configuredProjectPaths.map((value) => path.resolve(value)));
  const processByPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const findings = [];
  const editors = [];
  const beeProcesses = [];

  for (const proc of processes) {
    if (proc.pid !== brokerPid && isBrokerDaemon(proc.command)) {
      findings.push({ severity: 'error', kind: 'duplicate_broker', pid: proc.pid });
    }
    if (isUnityMcp(proc.command) && !managedChildren.has(proc.pid)) {
      findings.push({
        severity: 'error',
        kind: 'direct_unmanaged_unity_mcp',
        pid: proc.pid,
        projectPath: projectArgument(proc.command),
      });
    }
    if (!managedAdapters.has(proc.pid) && isRouterAdapter(proc.command)) {
      findings.push({ severity: 'error', kind: 'legacy_or_unattached_adapter', pid: proc.pid });
    }
    if (isUnityEditor(proc.command) && !isUnityEditorHelper(proc.command)) {
      editors.push({ pid: proc.pid, projectPath: projectArgument(proc.command) });
    }
    if (isBeeBackend(proc.command)) beeProcesses.push(proc);
  }

  const editorPids = new Set(editors.map((editor) => editor.pid));
  const beeBackends = beeProcesses.map((proc) => Object.freeze({
    pid: proc.pid,
    ppid: proc.ppid,
    editorPid: findAncestorEditorPid(proc, processByPid, editorPids),
  }));
  const orphanedBeePids = beeBackends
    .filter((bee) => bee.editorPid == null)
    .map((bee) => bee.pid);
  if (orphanedBeePids.length > 0) {
    findings.push({
      severity: 'error',
      kind: 'orphaned_bee_backend',
      pids: orphanedBeePids,
    });
  }
  const beeEditorPids = [...new Set(beeBackends
    .map((bee) => bee.editorPid)
    .filter(Number.isSafeInteger))];
  if (beeEditorPids.length > 1) {
    findings.push({
      severity: 'error',
      kind: 'bee_backend_multiple_editor_sessions',
      editorPids: beeEditorPids,
      pids: beeBackends.map((bee) => bee.pid),
    });
  }

  const byProject = new Map();
  for (const editor of editors) {
    if (!editor.projectPath) {
      findings.push({ severity: 'error', kind: 'editor_project_unknown', pid: editor.pid });
      continue;
    }
    if (!byProject.has(editor.projectPath)) byProject.set(editor.projectPath, []);
    byProject.get(editor.projectPath).push(editor.pid);
    if (!configured.has(editor.projectPath)) {
      // Never dereference this path in the broker: a symlink may live on a
      // stalled removable volume. Require Editors to be opened with the exact
      // installer-canonical path so an alias cannot bypass duplicate-project
      // detection when a floating licence allows two processes.
      findings.push({ severity: 'error', kind: 'unconfigured_editor', pid: editor.pid, projectPath: editor.projectPath });
    }
  }
  for (const [projectPath, pids] of byProject) {
    if (pids.length > 1) findings.push({ severity: 'error', kind: 'duplicate_project_editor', projectPath, pids });
  }
  if (editors.length > maxConcurrentEditors) {
    findings.push({
      severity: 'error',
      kind: 'editor_seat_limit_exceeded',
      editorCount: editors.length,
      maxConcurrentEditors,
      pids: editors.map((editor) => editor.pid),
    });
  }
  return Object.freeze({
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings: Object.freeze(findings),
    editors: Object.freeze(editors),
    beeBackends: Object.freeze(beeBackends),
  });
}

export function listProcesses({
  execFileImpl = execFile,
  timeoutMs = PROCESS_AUDIT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,command='],
      {
        maxBuffer: PROCESS_AUDIT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessTable(stdout));
      },
    );
  });
}

export async function auditSystemProcesses(options = {}, {
  listProcessesImpl = listProcesses,
} = {}) {
  try {
    return auditProcessTable(await listProcessesImpl(), options);
  } catch (error) {
    return Object.freeze({
      ok: false,
      findings: Object.freeze([{ severity: 'error', kind: 'process_audit_failed', message: error.message }]),
      editors: Object.freeze([]),
      beeBackends: Object.freeze([]),
    });
  }
}
