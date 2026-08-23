import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MCP_PROTOCOL_VERSION,
  ROUTER_OPERATION_META_KEY,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  negotiateMcpProtocolVersion,
  readRouterOperationMeta,
  withRouterOperationMeta,
} from '../../lib/mcp-protocol.mjs';

test('negotiates the frozen downstream MCP revision instead of echoing arbitrary clients', () => {
  assert.deepEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS, ['2025-06-18']);
  assert.equal(negotiateMcpProtocolVersion('2025-06-18'), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion('2025-11-25'), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion('not-a-version'), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion(undefined), MCP_PROTOCOL_VERSION);
});

test('adds router delivery metadata without changing child result semantics', () => {
  const childResult = {
    content: [{ type: 'text', text: '{"status":"completed"}' }],
    isError: false,
    _meta: { 'child.example/trace': { traceId: 'trace-1' } },
  };
  const decorated = withRouterOperationMeta(childResult, 'operation-1', 'COMPLETED', {
    deliveryAckRequired: true,
  });

  assert.deepEqual(childResult, {
    content: [{ type: 'text', text: '{"status":"completed"}' }],
    isError: false,
    _meta: { 'child.example/trace': { traceId: 'trace-1' } },
  });
  assert.deepEqual(decorated.content, childResult.content);
  assert.equal(decorated.isError, false);
  assert.equal(Object.hasOwn(decorated, 'structuredContent'), false);
  assert.deepEqual(decorated._meta['child.example/trace'], { traceId: 'trace-1' });
  assert.deepEqual(decorated._meta[ROUTER_OPERATION_META_KEY], {
    routerOperationId: 'operation-1',
    routerOperationState: 'COMPLETED',
    routerDeliveryAckRequired: true,
  });
  assert.deepEqual(readRouterOperationMeta(decorated), decorated._meta[ROUTER_OPERATION_META_KEY]);
});

test('reads only a valid namespaced router operation sideband', () => {
  assert.equal(readRouterOperationMeta({
    structuredContent: {
      routerOperationId: 'legacy-operation',
      routerOperationState: 'COMPLETED',
      routerDeliveryAckRequired: true,
    },
  }), null);
  assert.equal(readRouterOperationMeta({
    _meta: { [ROUTER_OPERATION_META_KEY]: 'invalid' },
  }), null);

  const decorated = withRouterOperationMeta({ content: [] }, 'operation-2', 'CANCELLED');
  assert.deepEqual(readRouterOperationMeta(decorated), {
    routerOperationId: 'operation-2',
    routerOperationState: 'CANCELLED',
  });
});
