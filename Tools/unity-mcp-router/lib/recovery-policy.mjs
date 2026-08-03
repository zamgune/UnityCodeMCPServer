/**
 * Fail-closed tool classification and retry policy for the Unity MCP broker.
 *
 * MCP tool annotations are hints, not an idempotency contract. Unknown tools
 * therefore default to a heavy mutation and are never replayed after dispatch.
 */

export const TOOL_CLASSES = Object.freeze({
  SAFE_READ: 'safe_read',
  LIGHT_MUTATION: 'light_mutation',
  HEAVY: 'heavy',
  EXCLUSIVE: 'exclusive',
  TRACKED_ASYNC: 'tracked_async',
  UNKNOWN: 'unknown',
});

const VALID_CLASSES = new Set(Object.values(TOOL_CLASSES));

export const DEFAULT_TOOL_CLASS_BY_NAME = Object.freeze({
  editor_status: TOOL_CLASSES.SAFE_READ,
  get_console_logs: TOOL_CLASSES.SAFE_READ,
  list_tests: TOOL_CLASSES.SAFE_READ,
  test_status: TOOL_CLASSES.SAFE_READ,
  build_status: TOOL_CLASSES.SAFE_READ,
  switch_build_target_status: TOOL_CLASSES.SAFE_READ,
  recompile_status: TOOL_CLASSES.SAFE_READ,
  package_status: TOOL_CLASSES.SAFE_READ,
  list_open_scenes: TOOL_CLASSES.SAFE_READ,

  clear_console: TOOL_CLASSES.LIGHT_MUTATION,
  editor_play: TOOL_CLASSES.LIGHT_MUTATION,
  editor_pause: TOOL_CLASSES.LIGHT_MUTATION,
  editor_stop: TOOL_CLASSES.LIGHT_MUTATION,
  zamgune_play_begin: TOOL_CLASSES.LIGHT_MUTATION,
  zamgune_play_step: TOOL_CLASSES.LIGHT_MUTATION,
  zamgune_play_end: TOOL_CLASSES.LIGHT_MUTATION,

  eval: TOOL_CLASSES.HEAVY,
  eval_file: TOOL_CLASSES.HEAVY,
  capture_game_view: TOOL_CLASSES.HEAVY,
  capture_scene_view: TOOL_CLASSES.HEAVY,
  zamgune_capture_game_view: TOOL_CLASSES.HEAVY,

  build: TOOL_CLASSES.EXCLUSIVE,
  build_player: TOOL_CLASSES.EXCLUSIVE,
  switch_active_build_target: TOOL_CLASSES.EXCLUSIVE,
  set_active_build_target: TOOL_CLASSES.EXCLUSIVE,
  switch_build_target: TOOL_CLASSES.EXCLUSIVE,
  import_package: TOOL_CLASSES.EXCLUSIVE,
  install_package: TOOL_CLASSES.EXCLUSIVE,

  run_tests: TOOL_CLASSES.TRACKED_ASYNC,
  recompile: TOOL_CLASSES.TRACKED_ASYNC,
  package_add: TOOL_CLASSES.TRACKED_ASYNC,
  package_remove: TOOL_CLASSES.TRACKED_ASYNC,
  package_resolve: TOOL_CLASSES.TRACKED_ASYNC,
});

function normalizeClass(kind) {
  if (!VALID_CLASSES.has(kind)) {
    throw new TypeError(`Unknown Unity tool class: ${kind}`);
  }
  return kind;
}

function hasBuiltInToolClass(toolName) {
  return Object.hasOwn(DEFAULT_TOOL_CLASS_BY_NAME, toolName);
}

export function validateToolClassOverrides(overrides = {}) {
  if (
    !(overrides instanceof Map)
    && (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides))
  ) {
    throw new TypeError('Unity tool class overrides must be an object or Map');
  }

  const entries = overrides instanceof Map ? overrides.entries() : Object.entries(overrides);
  for (const [toolName, kind] of entries) {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new TypeError('Unity tool class override names must be non-empty strings');
    }
    normalizeClass(kind);
    if (hasBuiltInToolClass(toolName)) {
      throw new TypeError(`Cannot override built-in Unity tool class: ${toolName}`);
    }
  }
}

export function isMutationClass(kind) {
  return normalizeClass(kind) !== TOOL_CLASSES.SAFE_READ;
}

function describeClass(toolName, kind, source) {
  const mutation = kind !== TOOL_CLASSES.SAFE_READ;
  const exclusive = kind === TOOL_CLASSES.EXCLUSIVE;
  const trackedAsync = kind === TOOL_CLASSES.TRACKED_ASYNC;
  const heavy =
    kind === TOOL_CLASSES.HEAVY ||
    kind === TOOL_CLASSES.EXCLUSIVE ||
    kind === TOOL_CLASSES.TRACKED_ASYNC ||
    kind === TOOL_CLASSES.UNKNOWN;

  return Object.freeze({
    toolName,
    kind,
    source,
    mutation,
    heavy,
    exclusive,
    trackedAsync,
    retryableAfterDispatch: kind === TOOL_CLASSES.SAFE_READ,
  });
}

/**
 * Classify a tool. `overrides` is an object or Map of exact tool names to one
 * of TOOL_CLASSES. Built-in classifications are immutable. Unknown tools
 * remain fail-closed unless an explicit exact-name override is supplied.
 * `readOnlyHint` is intentionally ignored by default.
 */
export function classifyTool(
  toolName,
  { overrides, annotations, trustReadOnlyHint = false } = {},
) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new TypeError('toolName must be a non-empty string');
  }

  if (hasBuiltInToolClass(toolName)) {
    const configured = DEFAULT_TOOL_CLASS_BY_NAME[toolName];
    return describeClass(toolName, configured, 'built_in');
  }

  const override = overrides instanceof Map
    ? overrides.get(toolName)
    : (overrides != null && Object.hasOwn(overrides, toolName) ? overrides[toolName] : undefined);
  if (override != null) {
    return describeClass(toolName, normalizeClass(override), 'override');
  }

  if (trustReadOnlyHint && annotations?.readOnlyHint === true) {
    return describeClass(toolName, TOOL_CLASSES.SAFE_READ, 'annotation');
  }

  return describeClass(toolName, TOOL_CLASSES.UNKNOWN, 'fail_closed');
}

/**
 * Decide whether a response-lost/transport-failed call may be replayed after
 * it was dispatched. `retriesUsed` counts completed recovery retries, not the
 * initial attempt.
 */
export function canRetryAfterDispatch(
  classification,
  { retriesUsed = 0, safeReadRetries = 1 } = {},
) {
  const kind = typeof classification === 'string' ? classification : classification?.kind;
  normalizeClass(kind);
  if (!Number.isInteger(retriesUsed) || retriesUsed < 0) {
    throw new TypeError('retriesUsed must be a non-negative integer');
  }
  if (!Number.isInteger(safeReadRetries) || safeReadRetries < 0) {
    throw new TypeError('safeReadRetries must be a non-negative integer');
  }
  return kind === TOOL_CLASSES.SAFE_READ && retriesUsed < safeReadRetries;
}

export function createRecoveryPolicy({ safeReadRetries = 1, toolClasses = {} } = {}) {
  if (!Number.isInteger(safeReadRetries) || safeReadRetries < 0) {
    throw new TypeError('safeReadRetries must be a non-negative integer');
  }

  const overrides = toolClasses instanceof Map ? new Map(toolClasses) : { ...toolClasses };
  validateToolClassOverrides(overrides);

  return Object.freeze({
    safeReadRetries,
    classify(toolName, options = {}) {
      return classifyTool(toolName, { ...options, overrides });
    },
    canRetry(classification, retriesUsed = 0) {
      return canRetryAfterDispatch(classification, { retriesUsed, safeReadRetries });
    },
  });
}
