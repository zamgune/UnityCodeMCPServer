export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION]);

export function negotiateMcpProtocolVersion(requestedVersion) {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : MCP_PROTOCOL_VERSION;
}
