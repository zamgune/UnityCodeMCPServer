import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, FAILURE_CLASSIFICATION_SAMPLES } from '../../lib/failure-classifier.mjs';

test('classifies known official CLI and Pipeline failures', () => {
  for (const [message, expected] of FAILURE_CLASSIFICATION_SAMPLES) {
    const response = { result: { isError: true, content: [{ type: 'text', text: message }] } };
    assert.equal(classifyFailure(response), expected, message);
  }
});

test('marks child exit and timeout metadata as transport failure', () => {
  assert.equal(classifyFailure({ transportFailure: true, error: { message: 'child exited' } }), 'transport');
});
