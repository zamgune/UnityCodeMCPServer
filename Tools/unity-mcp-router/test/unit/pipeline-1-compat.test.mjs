import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asyncCorrelationFor, asyncSpecByStatusTool, asyncSpecFor, asyncSpecForRecovery,
  responseIsTerminal, responseMatchesAsyncCorrelation, responseStartsAsync,
} from '../../lib/async-operation-policy.mjs';
import { classifyTool, createRecoveryPolicy, TOOL_CLASSES } from '../../lib/recovery-policy.mjs';

const response = (value, isError = false) => ({ result: {
  content: [{ type: 'text', text: JSON.stringify(value) }], isError,
} });

test('grouped async commands retain their own status, argument and cancellation contracts', () => {
  for (const [trigger, status, args, active] of [
    ['build_run', 'build_status', {}, 'queued'],
    ['build_target_switch', 'build_target_switch_status', {}, 'switching'],
    ['script_recompile', 'script_recompile_status', {}, 'compiling'],
    ['test_run', 'test_status', { 'async-tests': true }, 'running'],
  ]) {
    const spec = asyncSpecFor(trigger, args);
    assert.equal(spec.statusTool, status);
    assert.equal(responseStartsAsync(spec, response({ status: active })), true);
    assert.equal(responseIsTerminal(spec, response({ status: 'completed' })), true);
    assert.equal(asyncSpecForRecovery(trigger).statusTool, status);
    assert.ok(asyncSpecByStatusTool(status));
  }
  assert.deepEqual(asyncSpecFor('test_run', { 'async-tests': true }).allowedMutations, ['test_cancel']);
  assert.equal(asyncSpecFor('test_run'), null);
  assert.equal(asyncSpecFor('test_run', { async_tests: true }), null);
  assert.equal(asyncSpecFor('run_tests', { 'async-tests': true }), null);
  assert.equal(asyncSpecFor('test_run', { 'async-tests': 'true' }), null);
  assert.equal(asyncSpecFor('toString'), null);
  assert.equal(asyncSpecForRecovery('global_test_run'), null);
});

test('dry-run and synchronous package work never acquire an async hold', () => {
  for (const name of ['package_add', 'package_remove']) {
    for (const args of [{ 'dry-run': true }, { dry_run: true }, { wait: true }]) {
      assert.equal(asyncSpecFor(name, args), null);
    }
    assert.equal(responseStartsAsync(asyncSpecFor(name), response({ status: 'in_progress' })), true);
  }
});

test('modern build correlation and test failure terminal state survive raw JSON results', () => {
  const spec = asyncSpecFor('build_run');
  const correlation = asyncCorrelationFor(spec, response({ status: 'queued', buildId: 'new-build' }));
  assert.deepEqual(correlation, { buildId: 'new-build' });
  assert.equal(responseMatchesAsyncCorrelation(correlation, response({ status: 'completed', buildId: 'old-build' })), false);
  const tests = asyncSpecForRecovery('test_run');
  assert.equal(responseIsTerminal(tests, response({ status: 'completed', summary: { failed: 1, total: 2 } }, true)), true);
  assert.equal(responseStartsAsync(tests, response({ status: 'running' }, true)), false);
});

test('only exact known grouped reads may retry; grouped mutations and global custom names fail closed', () => {
  for (const name of ['scene_list_open', 'scene_get_hierarchy', 'gameobject_find', 'console_get',
    'console_status', 'test_list', 'script_recompile_status', 'build_target_switch_status']) {
    assert.equal(classifyTool(name).kind, TOOL_CLASSES.SAFE_READ);
    assert.equal(classifyTool(name).retryableAfterDispatch, true);
    assert.throws(() => createRecoveryPolicy({ toolClasses: { [name]: TOOL_CLASSES.HEAVY } }));
  }
  for (const name of ['test_run', 'script_recompile', 'script_eval', 'script_run', 'build_run',
    'build_target_switch', 'test_cancel', 'editor_playmode_start', 'console_clear']) {
    assert.equal(classifyTool(name).mutation, true);
    assert.equal(classifyTool(name).retryableAfterDispatch, false);
    assert.throws(() => createRecoveryPolicy({ toolClasses: { [name]: TOOL_CLASSES.SAFE_READ } }));
  }
  for (const name of ['global_editor_status', 'global_scene_list_open', 'script_new_command']) {
    assert.equal(classifyTool(name, { annotations: { readOnlyHint: true } }).kind, TOOL_CLASSES.UNKNOWN);
  }
});
