import { TextDecoder } from 'node:util';

export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export const FRAMING_ERROR_CODES = Object.freeze({
  MALFORMED: 'MCP_FRAME_MALFORMED',
  TOO_LARGE: 'MCP_FRAME_TOO_LARGE',
  EMBEDDED_NEWLINE: 'MCP_FRAME_EMBEDDED_NEWLINE',
  INVALID_UTF8: 'MCP_FRAME_INVALID_UTF8',
  UNTERMINATED: 'MCP_FRAME_UNTERMINATED',
  FAILED: 'MCP_FRAMER_FAILED',
});

const LF = 0x0a;
const CR = 0x0d;
const LF_BUFFER = Buffer.from('\n');

export class McpFramingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'McpFramingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function assertMaxLineBytes(maxLineBytes) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new TypeError('maxLineBytes must be a positive safe integer');
  }
}

function toBuffer(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError('JSON-RPC input chunk must be a string, Buffer, ArrayBuffer, or typed array');
}

function assertJsonRpcEnvelope(value, lineNumber) {
  const isObject = value !== null && typeof value === 'object';
  const isEmptyBatch = Array.isArray(value) && value.length === 0;
  if (!isObject || isEmptyBatch) {
    throw new McpFramingError(
      FRAMING_ERROR_CODES.MALFORMED,
      'A JSON-RPC frame must contain an object or a non-empty batch array',
      { lineNumber },
    );
  }
}

/**
 * Incremental newline-delimited JSON-RPC decoder.
 *
 * The decoder works on bytes so split UTF-8 code points and byte limits are
 * handled correctly. A terminal CR is accepted only as part of CRLF framing;
 * any other raw CR is treated as an embedded newline and rejected.
 */
export class JsonRpcLineDecoder {
  #buffer = Buffer.alloc(0);
  #failed = false;
  #lineNumber = 0;

  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    assertMaxLineBytes(maxLineBytes);
    this.maxLineBytes = maxLineBytes;
  }

  get bufferedBytes() {
    return this.#buffer.length;
  }

  push(chunk) {
    if (this.#failed) {
      throw new McpFramingError(
        FRAMING_ERROR_CODES.FAILED,
        'The JSON-RPC decoder is in a failed state; call reset() before reuse',
      );
    }

    const bytes = toBuffer(chunk);
    if (bytes.length === 0) return [];
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.#buffer, bytes]);

    const messages = [];
    let newlineIndex;
    while ((newlineIndex = this.#buffer.indexOf(LF)) >= 0) {
      let line = this.#buffer.subarray(0, newlineIndex);
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);
      this.#lineNumber += 1;

      if (line.length > 0 && line[line.length - 1] === CR) {
        line = line.subarray(0, line.length - 1);
      }

      if (line.indexOf(CR) >= 0) {
        this.#fail(
          FRAMING_ERROR_CODES.EMBEDDED_NEWLINE,
          'Raw embedded newlines are not permitted inside a JSON-RPC frame',
          { lineNumber: this.#lineNumber },
        );
      }
      if (line.length === 0) continue;
      if (line.length > this.maxLineBytes) {
        this.#fail(
          FRAMING_ERROR_CODES.TOO_LARGE,
          `JSON-RPC frame exceeds the ${this.maxLineBytes}-byte limit`,
          { lineNumber: this.#lineNumber, maxLineBytes: this.maxLineBytes },
        );
      }

      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      } catch {
        this.#fail(
          FRAMING_ERROR_CODES.INVALID_UTF8,
          'JSON-RPC frame is not valid UTF-8',
          { lineNumber: this.#lineNumber },
        );
      }

      let message;
      try {
        message = JSON.parse(text);
      } catch {
        this.#fail(
          FRAMING_ERROR_CODES.MALFORMED,
          'Malformed JSON-RPC line; embedded newlines are not permitted',
          { lineNumber: this.#lineNumber },
        );
      }
      try {
        assertJsonRpcEnvelope(message, this.#lineNumber);
      } catch (error) {
        this.#failed = true;
        this.#buffer = Buffer.alloc(0);
        throw error;
      }
      messages.push(message);
    }

    const terminalCrBytes = this.#buffer[this.#buffer.length - 1] === CR ? 1 : 0;
    const embeddedCrIndex = this.#buffer.indexOf(CR);
    if (embeddedCrIndex >= 0 && embeddedCrIndex !== this.#buffer.length - 1) {
      this.#fail(
        FRAMING_ERROR_CODES.EMBEDDED_NEWLINE,
        'Raw embedded newlines are not permitted inside a JSON-RPC frame',
        { lineNumber: this.#lineNumber + 1 },
      );
    }
    if (this.#buffer.length - terminalCrBytes > this.maxLineBytes) {
      this.#fail(
        FRAMING_ERROR_CODES.TOO_LARGE,
        `JSON-RPC frame exceeds the ${this.maxLineBytes}-byte limit`,
        { lineNumber: this.#lineNumber + 1, maxLineBytes: this.maxLineBytes },
      );
    }

    return messages;
  }

  end() {
    if (this.#failed) {
      throw new McpFramingError(
        FRAMING_ERROR_CODES.FAILED,
        'The JSON-RPC decoder is in a failed state; call reset() before reuse',
      );
    }
    if (this.#buffer.length !== 0) {
      this.#fail(
        FRAMING_ERROR_CODES.UNTERMINATED,
        'JSON-RPC stream ended with an unterminated frame',
        { lineNumber: this.#lineNumber + 1, bufferedBytes: this.#buffer.length },
      );
    }
    return [];
  }

  reset() {
    this.#buffer = Buffer.alloc(0);
    this.#failed = false;
    this.#lineNumber = 0;
  }

  #fail(code, message, details) {
    this.#failed = true;
    this.#buffer = Buffer.alloc(0);
    throw new McpFramingError(code, message, details);
  }
}

export function createJsonRpcLineDecoder(options) {
  return new JsonRpcLineDecoder(options);
}

/** Encode one JSON-RPC message as exactly one newline-terminated UTF-8 frame. */
export function encodeJsonRpcLine(message, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  assertMaxLineBytes(maxLineBytes);
  assertJsonRpcEnvelope(message, 1);

  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw new McpFramingError(
      FRAMING_ERROR_CODES.MALFORMED,
      'JSON-RPC message is not JSON serializable',
    );
  }
  if (typeof serialized !== 'string') {
    throw new McpFramingError(
      FRAMING_ERROR_CODES.MALFORMED,
      'JSON-RPC message is not JSON serializable',
    );
  }
  // `toJSON()` is allowed to replace an object with a scalar or empty value.
  // Validate the actual encoded envelope rather than only the caller's input.
  try {
    assertJsonRpcEnvelope(JSON.parse(serialized), 1);
  } catch (error) {
    if (error instanceof McpFramingError) throw error;
    throw new McpFramingError(
      FRAMING_ERROR_CODES.MALFORMED,
      'JSON-RPC message is not JSON serializable',
    );
  }
  if (serialized.includes('\n') || serialized.includes('\r')) {
    throw new McpFramingError(
      FRAMING_ERROR_CODES.EMBEDDED_NEWLINE,
      'Encoded JSON-RPC messages may not contain raw embedded newlines',
    );
  }

  const payload = Buffer.from(serialized, 'utf8');
  if (payload.length > maxLineBytes) {
    throw new McpFramingError(
      FRAMING_ERROR_CODES.TOO_LARGE,
      `JSON-RPC frame exceeds the ${maxLineBytes}-byte limit`,
      { maxLineBytes },
    );
  }
  return Buffer.concat([payload, LF_BUFFER]);
}

// Short aliases for broker/adapter call sites.
export const NdjsonRpcDecoder = JsonRpcLineDecoder;
export const encode = encodeJsonRpcLine;
