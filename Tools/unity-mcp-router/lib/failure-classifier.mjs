const AUTH_PATTERNS = [
  /\b401\b/,
  /unauthori[sz]ed/i,
  /unauthenticated/i,
  /not\s+(?:signed|logged)\s+in/i,
  /invalid[\s_-]?token/i,
  /token\s+(?:has\s+)?expired/i,
  /expired[\s_-]?(?:access[\s_-]?)?token/i,
  /session\s+(?:is\s+)?(?:invalid|expired)/i,
  /\b403\b.*\b(?:auth|token|credential)/i,
];

const EDITOR_PATTERNS = [
  /no\s+(?:running\s+)?(?:unity\s+)?editor/i,
  /editor\s+(?:is\s+)?not\s+(?:connected|running|available|ready|found)/i,
  /not\s+connected\s+to\s+(?:the\s+)?editor/i,
  /could\s+not\s+(?:connect|discover)/i,
  /connection\s+(?:refused|reset|closed)/i,
  /ECONNREFUSED|ECONNRESET|EPIPE/,
  /pipeline\s+(?:package\s+)?not\s+(?:installed|found)/i,
  /no\s+pipeline\s+instance/i,
  /make\s+sure\s+.*editor\s+is\s+running/i,
  /failed\s+to\s+(?:reach|attach\s+to)\s+.*editor/i,
];

export function textOfPayload(payload) {
  const parts = [];
  const walk = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
    else if (typeof value === 'object') Object.values(value).forEach((item) => walk(item, depth + 1));
  };
  walk(payload);
  return parts.join('\n');
}

/** Returns auth, editor, transport, or null. */
export function classifyFailure(response) {
  if (!response) return null;
  if (response.transportFailure === true) return 'transport';
  const isErrorResult = response.result?.isError === true;
  if (!response.error && !isErrorResult) return null;
  const blob = textOfPayload(response.error ?? response.result);
  if (AUTH_PATTERNS.some((pattern) => pattern.test(blob))) return 'auth';
  if (EDITOR_PATTERNS.some((pattern) => pattern.test(blob))) return 'editor';
  return null;
}

export const FAILURE_CLASSIFICATION_SAMPLES = Object.freeze([
  ['No Pipeline instance found for project: /p. Make sure Unity Editor is running with the Pipeline package installed.', 'editor'],
  ['connect ECONNREFUSED 127.0.0.1:9002', 'editor'],
  ['Unity Editor is not connected', 'editor'],
  ['Request failed with status code 401 Unauthorized', 'auth'],
  ['The access token has expired', 'auth'],
  ['Compilation failed: CS1002 expected ;', null],
]);
