const SPECS = Object.freeze({
  build: Object.freeze({ statusTool: 'build_status', active: ['queued', 'building'], terminal: ['completed', 'failed', 'cancelled', 'error'], exclusive: true }),
  switch_build_target: Object.freeze({ statusTool: 'switch_build_target_status', active: ['switching'], terminal: ['completed', 'failed', 'error'], exclusive: true }),
  recompile: Object.freeze({ statusTool: 'recompile_status', active: ['triggered', 'compiling'], terminal: ['completed', 'up_to_date', 'failed', 'error'] }),
  run_tests: Object.freeze({ statusTool: 'test_status', active: ['running', 'in_progress'], terminal: ['completed', 'cancelled', 'failed', 'error', 'no_tests'], when: (args) => args.async_tests === true, allowedMutations: ['cancel_tests'] }),
  package_add: Object.freeze({ statusTool: 'package_status', active: ['in_progress'], terminal: ['completed', 'failed', 'error'], when: (args) => args.wait !== true && args.dry_run !== true }),
  package_remove: Object.freeze({ statusTool: 'package_status', active: ['in_progress'], terminal: ['completed', 'failed', 'error'], when: (args) => args.wait !== true && args.dry_run !== true }),
  package_resolve: Object.freeze({ statusTool: 'package_status', active: ['in_progress', 'queued'], terminal: ['completed', 'failed', 'error'], assumeActiveOnSuccess: true }),
});

function collectStatuses(value, output, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { collectStatuses(JSON.parse(trimmed), output, depth + 1); } catch { /* ordinary text */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStatuses(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key.toLowerCase() === 'status' || key.toLowerCase() === 'result') && typeof child === 'string') {
      output.add(child.toLowerCase());
    }
    collectStatuses(child, output, depth + 1);
  }
}

function collectNamedStrings(value, fieldName, output, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { collectNamedStrings(JSON.parse(trimmed), fieldName, output, depth + 1); } catch { /* ordinary text */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedStrings(item, fieldName, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === fieldName.toLowerCase() && typeof child === 'string' && child) output.add(child);
    collectNamedStrings(child, fieldName, output, depth + 1);
  }
}

function collectRecompileCompletions(value, state, depth = 0) {
  if (depth > 8 || value == null || state.invalid) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 * 1024 || !['{', '[', '"'].includes(trimmed[0])) return;
    try {
      collectRecompileCompletions(JSON.parse(trimmed), state, depth + 1);
    } catch {
      // JSON-looking completion evidence is not safe to ignore: a valid
      // sibling plus malformed text would otherwise make the result
      // ambiguous and could announce a schema refresh on a failed compile.
      state.invalid = true;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRecompileCompletions(item, state, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (state.seen.has(value)) return;
  state.seen.add(value);

  const keys = Object.keys(value);
  const hasCompletionField = keys.some((key) => ['status', 'failed', 'errors'].includes(key.toLowerCase()));
  if (hasCompletionField) {
    state.candidates += 1;
    if (
      value.status !== 'completed' ||
      value.failed !== false ||
      !Array.isArray(value.errors) ||
      value.errors.length !== 0
    ) state.invalid = true;
  }

  for (const child of Object.values(value)) {
    collectRecompileCompletions(child, state, depth + 1);
  }
}

export function responseStatuses(response) {
  const statuses = new Set();
  collectStatuses(response, statuses);
  return statuses;
}

export function asyncSpecFor(toolName, args = {}) {
  const spec = SPECS[toolName];
  if (!spec || (spec.when && !spec.when(args))) return null;
  return Object.freeze({
    triggerTool: toolName,
    statusTool: spec.statusTool,
    active: Object.freeze([...spec.active]),
    terminal: Object.freeze([...spec.terminal]),
    exclusive: spec.exclusive === true,
    assumeActiveOnSuccess: spec.assumeActiveOnSuccess === true,
    allowedMutations: Object.freeze([...(spec.allowedMutations ?? [])]),
  });
}

export function responseStartsAsync(spec, response) {
  if (!spec || response?.error || response?.result?.isError === true) return false;
  const statuses = responseStatuses(response);
  if ([...statuses].some((status) => spec.terminal.includes(status))) return false;
  if ([...statuses].some((status) => spec.active.includes(status))) return true;
  return spec.assumeActiveOnSuccess;
}

export function responseIsTerminal(spec, response) {
  if (!spec) return false;
  const statuses = responseStatuses(response);
  return [...statuses].some((status) => spec.terminal.includes(status));
}

export function isSuccessfulRecompileCompletion(response) {
  if (
    response == null ||
    typeof response !== 'object' ||
    response.transportFailure === true ||
    response.error != null ||
    response.result?.isError === true
  ) return false;

  const state = { candidates: 0, invalid: false, seen: new WeakSet() };
  collectRecompileCompletions(response.result, state);
  return state.candidates > 0 && state.invalid === false;
}

export function asyncCorrelationFor(spec, response) {
  if (spec?.triggerTool !== 'build') return null;
  const buildIds = new Set();
  collectNamedStrings(response, 'buildId', buildIds);
  const buildId = [...buildIds][0];
  return buildId ? Object.freeze({ buildId }) : null;
}

export function responseMatchesAsyncCorrelation(correlation, response) {
  if (!correlation) return true;
  if (correlation.buildId) {
    const buildIds = new Set();
    collectNamedStrings(response, 'buildId', buildIds);
    return buildIds.has(correlation.buildId);
  }
  return true;
}

export function asyncSpecByStatusTool(statusTool) {
  for (const [triggerTool] of Object.entries(SPECS)) {
    const spec = asyncSpecFor(triggerTool, triggerTool === 'run_tests' ? { async_tests: true } : {});
    if (spec?.statusTool === statusTool) return spec;
  }
  return null;
}
