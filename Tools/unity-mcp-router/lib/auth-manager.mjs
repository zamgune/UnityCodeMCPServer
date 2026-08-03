import { execFile } from 'node:child_process';
import { NULL_LOGGER } from './logger.mjs';
import { cliVersionStatus } from './cli-version.mjs';

export function runExecutable(file, args, { timeoutMs = 45_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

export class AuthManager {
  constructor({ unityBin, unityArgs = [], env = process.env, logger = NULL_LOGGER }) {
    this.unityBin = unityBin;
    this.unityArgs = unityArgs;
    this.env = env;
    this.logger = logger;
    this.inFlight = null;
    this.last = null;
    this.lastVersion = null;
  }

  async status({ force = false } = {}) {
    if (!force && this.last && Date.now() - this.last.checkedAt < 5_000) return this.last;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#status().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #status() {
    const result = await runExecutable(this.unityBin, [...this.unityArgs, 'auth', 'status'], {
      timeoutMs: 30_000,
      env: this.env,
    });
    const raw = `${result.stdout}\n${result.stderr}`.trim();
    const signedIn = result.ok && !/not\s+(?:signed|logged)\s+in/i.test(raw);
    this.last = { signedIn, raw, checkedAt: Date.now(), ok: result.ok, code: result.code };
    this.logger.info('unity auth status checked', { signedIn, ok: result.ok, code: result.code });
    return this.last;
  }

  async version() {
    if (this.lastVersion && Date.now() - this.lastVersion.checkedAt < 60_000) return this.lastVersion.value;
    const result = await runExecutable(this.unityBin, [...this.unityArgs, '--version'], {
      timeoutMs: 15_000,
      env: this.env,
    });
    const value = (result.stdout || result.stderr).trim() || 'unknown';
    this.lastVersion = { value, checkedAt: Date.now() };
    return value;
  }

  async compatibility(minimumCliVersion) {
    return cliVersionStatus(await this.version(), minimumCliVersion);
  }
}
