import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  negotiateMcpProtocolVersion,
} from '../../lib/mcp-protocol.mjs';

test('negotiates the frozen downstream MCP revision instead of echoing arbitrary clients', () => {
  assert.deepEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS, ['2025-06-18']);
  assert.equal(negotiateMcpProtocolVersion('2025-06-18'), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion('2025-11-25'), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion('not-a-version'), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion(undefined), MCP_PROTOCOL_VERSION);
});
