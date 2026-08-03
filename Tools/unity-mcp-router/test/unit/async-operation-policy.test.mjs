import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asyncCorrelationFor,
  asyncSpecFor,
  isSuccessfulRecompileCompletion,
  responseIsTerminal,
  responseMatchesAsyncCorrelation,
  responseStartsAsync,
  responseStatuses,
} from '../../lib/async-operation-policy.mjs';

test('recognizes async triggers only when their arguments and response start background work', () => {
  const build = asyncSpecFor('build', {});
  assert.equal(responseStartsAsync(build, { result: { content: [{ type: 'text', text: '{"status":"queued"}' }] } }), true);
  assert.equal(responseStartsAsync(build, { result: { structuredContent: { status: 'dry_run' } } }), false);
  assert.equal(asyncSpecFor('run_tests', { async_tests: false }), null);
  assert.equal(asyncSpecFor('run_tests', { async_tests: true }).statusTool, 'test_status');
  assert.equal(asyncSpecFor('package_add', { wait: true }), null);
});

test('correlates a build trigger and status by buildId across nested JSON text', () => {
  const spec = asyncSpecFor('build');
  const correlation = asyncCorrelationFor(spec, {
    result: { content: [{ type: 'text', text: '{"status":"queued","buildId":"build-123"}' }] },
  });
  assert.deepEqual(correlation, { buildId: 'build-123' });
  assert.equal(responseMatchesAsyncCorrelation(correlation, {
    result: { structuredContent: { status: 'completed', buildId: 'build-123' } },
  }), true);
  assert.equal(responseMatchesAsyncCorrelation(correlation, {
    result: { structuredContent: { status: 'completed', buildId: 'newer-build' } },
  }), false);
});

test('extracts nested or JSON-text statuses and recognizes terminal state', () => {
  assert.deepEqual([...responseStatuses({ content: [{ text: '{"status":"completed"}' }] })], ['completed']);
  assert.equal(responseIsTerminal(asyncSpecFor('recompile'), { result: { status: 'up_to_date' } }), true);
  assert.equal(responseIsTerminal(asyncSpecFor('build'), { result: { status: 'building' } }), false);
});

test('accepts only an exact successful recompile completion, including equivalent nested JSON text', () => {
  const completion = { status: 'completed', failed: false, errors: [], isCompiling: false };
  assert.equal(isSuccessfulRecompileCompletion({
    result: {
      isError: false,
      structuredContent: completion,
      content: [{ type: 'text', text: JSON.stringify(completion) }],
    },
  }), true);
  assert.equal(isSuccessfulRecompileCompletion({
    result: { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(completion)) }] },
  }), true);
});

test('fails closed for non-successful, incomplete, conflicting, malformed, or transport recompile results', () => {
  const result = (value) => ({ result: { structuredContent: value } });
  for (const value of [
    { status: 'up_to_date', failed: false, errors: [] },
    { status: 'compiling', failed: false, errors: [] },
    { status: 'failed', failed: true, errors: ['Compiler error'] },
    { status: 'error', failed: true, errors: ['Transport-independent command error'] },
    { status: 'completed', failed: true, errors: [] },
    { status: 'completed', failed: false, errors: ['Compiler error'] },
    { status: 'completed', failed: false },
    { failed: false, errors: [] },
  ]) assert.equal(isSuccessfulRecompileCompletion(result(value)), false, JSON.stringify(value));

  assert.equal(isSuccessfulRecompileCompletion({
    result: {
      structuredContent: { status: 'completed', failed: false, errors: [] },
      content: [{ type: 'text', text: '{"status":"failed"}' }],
    },
  }), false);
  assert.equal(isSuccessfulRecompileCompletion({
    result: {
      structuredContent: { status: 'completed', failed: false, errors: [] },
      content: [{ type: 'text', text: '{malformed-json}' }],
    },
  }), false);
  assert.equal(isSuccessfulRecompileCompletion({ transportFailure: true, result: result }), false);
  assert.equal(isSuccessfulRecompileCompletion({ error: { message: 'offline' }, result: result }), false);
  assert.equal(isSuccessfulRecompileCompletion({ result: { isError: true, structuredContent: result } }), false);
});
