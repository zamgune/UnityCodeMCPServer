import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAMING_ERROR_CODES,
  JsonRpcLineDecoder,
  McpFramingError,
  encodeJsonRpcLine,
} from '../../lib/mcp-framing.mjs';

function hasCode(code) {
  return (error) => error instanceof McpFramingError && error.code === code;
}

test('decodes a JSON-RPC frame split across arbitrary byte chunks', () => {
  const message = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: '양🐑' } },
  };
  const encoded = encodeJsonRpcLine(message);
  const sheepBytes = Buffer.from('🐑');
  const emojiStart = encoded.indexOf(sheepBytes);
  const decoder = new JsonRpcLineDecoder();

  assert.deepEqual(decoder.push(encoded.subarray(0, emojiStart + 1)), []);
  assert.deepEqual(decoder.push(encoded.subarray(emojiStart + 1, encoded.length - 1)), []);
  assert.deepEqual(decoder.push(encoded.subarray(encoded.length - 1)), [message]);
  assert.deepEqual(decoder.end(), []);
});

test('decodes multiple LF and CRLF frames from one chunk and ignores blank lines', () => {
  const first = { jsonrpc: '2.0', id: 1, result: { ok: true } };
  const second = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 2 } };
  const bytes = Buffer.concat([
    encodeJsonRpcLine(first),
    Buffer.from('\r\n'),
    Buffer.from(JSON.stringify(second) + '\r\n'),
  ]);

  assert.deepEqual(new JsonRpcLineDecoder().push(bytes), [first, second]);
});

test('rejects malformed JSON without echoing raw payload data', () => {
  const decoder = new JsonRpcLineDecoder();
  let thrown;
  try {
    decoder.push('{"secret":"do-not-log",}\n');
  } catch (error) {
    thrown = error;
  }

  assert.ok(hasCode(FRAMING_ERROR_CODES.MALFORMED)(thrown));
  assert.equal(thrown.details.lineNumber, 1);
  assert.doesNotMatch(thrown.message, /do-not-log/);
  assert.throws(() => decoder.push('{}\n'), hasCode(FRAMING_ERROR_CODES.FAILED));
});

test('rejects raw embedded CR and newline-split pretty JSON', () => {
  assert.throws(
    () => new JsonRpcLineDecoder().push('{"jsonrpc":"2.0"\r,"id":1}\n'),
    hasCode(FRAMING_ERROR_CODES.EMBEDDED_NEWLINE),
  );
  assert.throws(
    () => new JsonRpcLineDecoder().push('{\n  "jsonrpc": "2.0"\n}\n'),
    hasCode(FRAMING_ERROR_CODES.MALFORMED),
  );
});

test('enforces maxLineBytes on buffered input, complete frames, and encoding', () => {
  assert.throws(
    () => new JsonRpcLineDecoder({ maxLineBytes: 4 }).push('12345'),
    hasCode(FRAMING_ERROR_CODES.TOO_LARGE),
  );
  assert.throws(
    () => new JsonRpcLineDecoder({ maxLineBytes: 4 }).push('12345\n'),
    hasCode(FRAMING_ERROR_CODES.TOO_LARGE),
  );
  assert.throws(
    () => encodeJsonRpcLine({ jsonrpc: '2.0', id: 1 }, { maxLineBytes: 4 }),
    hasCode(FRAMING_ERROR_CODES.TOO_LARGE),
  );
});

test('counts the byte limit rather than JavaScript UTF-16 code units', () => {
  const serialized = JSON.stringify({ value: '한' });
  const byteLength = Buffer.byteLength(serialized);
  assert.ok(byteLength > serialized.length);

  const exact = new JsonRpcLineDecoder({ maxLineBytes: byteLength });
  assert.deepEqual(exact.push(serialized + '\n'), [{ value: '한' }]);
  assert.throws(
    () => new JsonRpcLineDecoder({ maxLineBytes: byteLength - 1 }).push(serialized + '\n'),
    hasCode(FRAMING_ERROR_CODES.TOO_LARGE),
  );
});

test('rejects invalid UTF-8 and unterminated EOF, then supports explicit reset', () => {
  const invalidUtf8 = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  assert.throws(
    () => new JsonRpcLineDecoder().push(invalidUtf8),
    hasCode(FRAMING_ERROR_CODES.INVALID_UTF8),
  );

  const decoder = new JsonRpcLineDecoder();
  decoder.push('{"jsonrpc":"2.0"}');
  assert.throws(() => decoder.end(), hasCode(FRAMING_ERROR_CODES.UNTERMINATED));
  decoder.reset();
  assert.deepEqual(decoder.push('{"jsonrpc":"2.0"}\n'), [{ jsonrpc: '2.0' }]);
});

test('encoder emits exactly one framing newline and escapes logical newlines', () => {
  const message = { jsonrpc: '2.0', id: 1, result: { text: 'line one\nline two' } };
  const encoded = encodeJsonRpcLine(message);

  assert.equal(encoded[encoded.length - 1], 0x0a);
  assert.equal(encoded.subarray(0, -1).indexOf(0x0a), -1);
  assert.equal(encoded.subarray(0, -1).indexOf(0x0d), -1);
  assert.deepEqual(new JsonRpcLineDecoder().push(encoded), [message]);
});

test('encoder rejects non-envelope and non-serializable values', () => {
  assert.throws(() => encodeJsonRpcLine('not-json-rpc'), hasCode(FRAMING_ERROR_CODES.MALFORMED));
  assert.throws(
    () => encodeJsonRpcLine({ jsonrpc: '2.0', params: { value: 1n } }),
    hasCode(FRAMING_ERROR_CODES.MALFORMED),
  );
  assert.throws(
    () => encodeJsonRpcLine({ toJSON: () => undefined }),
    hasCode(FRAMING_ERROR_CODES.MALFORMED),
  );
  assert.throws(
    () => encodeJsonRpcLine({ toJSON: () => 'scalar replacement' }),
    hasCode(FRAMING_ERROR_CODES.MALFORMED),
  );
});
