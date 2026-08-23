export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION]);
export const ROUTER_OPERATION_META_KEY = 'com.zamgune.unity-mcp-router/operation';

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function negotiateMcpProtocolVersion(requestedVersion) {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : MCP_PROTOCOL_VERSION;
}

export function withRouterOperationMeta(result, operationId, state, {
  deliveryAckRequired = false,
} = {}) {
  const base = isRecord(result)
    ? result
    : { content: [{ type: 'text', text: String(result ?? '') }] };
  const childMeta = isRecord(base._meta) ? base._meta : {};
  return {
    ...base,
    _meta: {
      ...childMeta,
      [ROUTER_OPERATION_META_KEY]: {
        routerOperationId: operationId,
        routerOperationState: state,
        ...(deliveryAckRequired ? { routerDeliveryAckRequired: true } : {}),
      },
    },
  };
}

export function readRouterOperationMeta(result) {
  const operation = isRecord(result?._meta)
    ? result._meta[ROUTER_OPERATION_META_KEY]
    : null;
  return isRecord(operation) ? operation : null;
}
