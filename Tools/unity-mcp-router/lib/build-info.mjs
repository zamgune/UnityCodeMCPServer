import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadBuildInfo(filePath = path.join(ROOT, 'release.json')) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof value.version !== 'string' || typeof value.buildId !== 'string') throw new Error('invalid release metadata');
    return Object.freeze({
      version: value.version,
      buildId: value.buildId,
      journalFormat: value.journalFormat ?? 2,
      builtAt: value.builtAt ?? null,
    });
  } catch {
    return Object.freeze({ version: '2.0.0-dev', buildId: 'unpackaged', journalFormat: 2, builtAt: null });
  }
}

export const BUILD_INFO = loadBuildInfo();
