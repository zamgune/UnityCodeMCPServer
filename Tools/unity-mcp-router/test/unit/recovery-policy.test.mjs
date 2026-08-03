import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_CLASSES,
  canRetryAfterDispatch,
  classifyTool,
  createRecoveryPolicy,
  isMutationClass,
} from '../../lib/recovery-policy.mjs';

test('classifies representative tools into all public classes', () => {
  assert.equal(classifyTool('editor_status').kind, TOOL_CLASSES.SAFE_READ);
  assert.equal(classifyTool('editor_play').kind, TOOL_CLASSES.LIGHT_MUTATION);
  assert.equal(classifyTool('eval').kind, TOOL_CLASSES.HEAVY);
  assert.equal(classifyTool('build_player').kind, TOOL_CLASSES.EXCLUSIVE);
  assert.equal(classifyTool('run_tests').kind, TOOL_CLASSES.TRACKED_ASYNC);
});

test('unknown tools fail closed as heavy mutations', () => {
  const result = classifyTool('custom_command_added_next_week');
  assert.equal(result.kind, TOOL_CLASSES.UNKNOWN);
  assert.equal(result.mutation, true);
  assert.equal(result.heavy, true);
  assert.equal(result.retryableAfterDispatch, false);
  assert.equal(result.source, 'fail_closed');
  assert.equal(isMutationClass(result.kind), true);
  assert.equal(classifyTool('toString').source, 'fail_closed');
});

test('readOnlyHint is not trusted unless explicitly enabled', () => {
  const annotations = { readOnlyHint: true };
  assert.equal(classifyTool('unregistered_status', { annotations }).kind, TOOL_CLASSES.UNKNOWN);
  assert.equal(
    classifyTool('unregistered_status', { annotations, trustReadOnlyHint: true }).kind,
    TOOL_CLASSES.SAFE_READ,
  );
});

test('only safe reads can retry after dispatch and retry budget is bounded', () => {
  const read = classifyTool('editor_status');
  const mutation = classifyTool('editor_play');
  assert.equal(canRetryAfterDispatch(read, { retriesUsed: 0, safeReadRetries: 1 }), true);
  assert.equal(canRetryAfterDispatch(read, { retriesUsed: 1, safeReadRetries: 1 }), false);
  assert.equal(canRetryAfterDispatch(mutation, { retriesUsed: 0, safeReadRetries: 9 }), false);
  assert.equal(
    canRetryAfterDispatch(TOOL_CLASSES.UNKNOWN, { retriesUsed: 0, safeReadRetries: 9 }),
    false,
  );
});

test('recovery policy supports explicit exact-name overrides', () => {
  const policy = createRecoveryPolicy({
    safeReadRetries: 1,
    toolClasses: { project_health: TOOL_CLASSES.SAFE_READ },
  });
  const health = policy.classify('project_health');
  assert.equal(health.kind, TOOL_CLASSES.SAFE_READ);
  assert.equal(health.source, 'override');
  assert.equal(policy.canRetry(health, 0), true);
  assert.equal(policy.canRetry(health, 1), false);
});

test('built-in classifications cannot be weakened or replaced by overrides', () => {
  const direct = classifyTool('eval', {
    overrides: { eval: TOOL_CLASSES.SAFE_READ },
  });
  assert.equal(direct.kind, TOOL_CLASSES.HEAVY);
  assert.equal(direct.source, 'built_in');
  assert.equal(direct.mutation, true);
  assert.equal(direct.retryableAfterDispatch, false);

  assert.throws(
    () => createRecoveryPolicy({
      toolClasses: { editor_play: TOOL_CLASSES.SAFE_READ },
    }),
    /Cannot override built-in Unity tool class: editor_play/,
  );
  assert.throws(
    () => createRecoveryPolicy({
      toolClasses: new Map([['run_tests', TOOL_CLASSES.SAFE_READ]]),
    }),
    /Cannot override built-in Unity tool class: run_tests/,
  );
});
