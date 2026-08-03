import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, decorateTools } from '../../lib/tool-registry.mjs';

const tool = (description = 'x') => ({
  name: 'editor_status',
  description,
  inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } }, additionalProperties: false },
});

test('schema compatibility ignores descriptions but catches input schema changes', () => {
  const registry = new ToolRegistry();
  registry.update('a', [tool('first')]);
  registry.update('b', [tool('second')]);
  assert.equal(registry.compatible('a', 'b', 'editor_status'), true);
  const descriptionOnly = registry.update('a', [tool('changed public description')]);
  assert.equal(descriptionOnly.changed, true);
  assert.equal(registry.compatible('a', 'b', 'editor_status'), true);
  registry.update('b', [{ ...tool(), inputSchema: { type: 'object', properties: { other: { type: 'string' } } } }]);
  assert.equal(registry.compatible('a', 'b', 'editor_status'), false);
});

test('decorates a copy and preserves strict child schema semantics downstream', () => {
  const original = tool();
  const [decorated] = decorateTools([original], { projectNames: ['A', 'B'], defaultProject: 'A' });
  assert.deepEqual(decorated.inputSchema.properties.project.enum, ['A', 'B']);
  assert.equal('project' in original.inputSchema.properties, false);
  assert.equal('additionalProperties' in decorated.inputSchema, false);
});

test('coalesces invalidations until rediscovery without trusting stale schemas', () => {
  const registry = new ToolRegistry();
  registry.update('a', [tool()]);
  registry.update('b', [tool()]);

  assert.deepEqual(registry.invalidate('a'), { newlyInvalidated: true });
  assert.deepEqual(registry.invalidate('a'), { newlyInvalidated: false });
  assert.equal(registry.get('a'), null);
  assert.equal(registry.hasKnownNonEmptyCatalog('a'), true);
  assert.equal(registry.compatible('a', 'b', 'editor_status'), false);

  const refresh = registry.update('a', [tool()]);
  assert.equal(refresh.wasInvalidated, true);
  assert.equal(refresh.changed, false);
  assert.equal(refresh.becameAvailable, false);
  assert.equal(registry.compatible('a', 'b', 'editor_status'), true);
  assert.deepEqual(registry.invalidate('a'), { newlyInvalidated: true });
});

test('known non-empty catalog remains observable while invalidated but not after an accepted empty catalog', () => {
  const registry = new ToolRegistry();
  assert.equal(registry.hasKnownNonEmptyCatalog('a'), false);
  registry.update('a', [tool()]);
  registry.invalidate('a');
  assert.equal(registry.hasKnownNonEmptyCatalog('a'), true);
  registry.update('a', []);
  assert.equal(registry.hasKnownNonEmptyCatalog('a'), false);
});
