import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY = /(token|authorization|credential|password|secret|evaltoken)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT = /((?:access[_-]?token|refresh[_-]?token|eval[_-]?token|token|api[_-]?key|authorization|credential|password|secret)(?:["']?\s*[:=]\s*["']?|\s+["']?))([^\s,;}"']+)/gi;
const SENSITIVE_ARG = /^--?(?:access[_-]?token|refresh[_-]?token|eval[_-]?token|token|api[_-]?key|authorization|credential|password|secret)$/i;

function redactString(value) {
  return value
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(JWT, '[REDACTED_JWT]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]');
}

export function redactLogValue(value, key = '', depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const prior = index > 0 ? value[index - 1] : null;
      if (typeof prior === 'string' && SENSITIVE_ARG.test(prior)) return '[REDACTED]';
      return redactLogValue(item, '', depth + 1);
    });
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactLogValue(childValue, childKey, depth + 1)]),
    );
  }
  return value;
}

export class StructuredLogger {
  constructor(filePath, { maxBytes = 10 * 1024 * 1024, maxFiles = 5, context = {} } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.maxFiles = Math.max(1, maxFiles);
    this.context = { ...context };
    this.disabled = !filePath;
    if (!this.disabled) {
      try {
        mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        if (existsSync(filePath)) {
          const stat = lstatSync(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('log path must be a regular file');
          chmodSync(filePath, 0o600);
        }
      } catch {
        this.disabled = true;
      }
    }
  }

  child(context) {
    return new StructuredLogger(this.filePath, {
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      context: { ...this.context, ...context },
    });
  }

  log(level, message, extra = undefined) {
    if (this.disabled) return;
    try {
      this.#rotateIfNeeded();
      const record = redactLogValue({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...this.context,
        ...(extra === undefined ? {} : { extra }),
      });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging must never break MCP transport or Unity recovery.
    }
  }

  debug(message, extra) { this.log('debug', message, extra); }
  info(message, extra) { this.log('info', message, extra); }
  warn(message, extra) { this.log('warn', message, extra); }
  error(message, extra) { this.log('error', message, extra); }

  #rotateIfNeeded() {
    if (!existsSync(this.filePath) || statSync(this.filePath).size < this.maxBytes) return;
    const oldest = `${this.filePath}.${this.maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = this.maxFiles - 1; index >= 1; index--) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const destination = `${this.filePath}.${index}`;
      if (existsSync(source)) renameSync(source, destination);
    }
  }
}

export const NULL_LOGGER = Object.freeze({
  log() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
});
