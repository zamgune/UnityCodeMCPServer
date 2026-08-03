import assert from 'node:assert/strict';
import test from 'node:test';

import { cliVersionStatus, compareCliVersions, parseCliVersion } from '../../lib/cli-version.mjs';

test('parses Unity CLI prerelease output and compares semantic prereleases', () => {
  assert.equal(parseCliVersion('Unity CLI 1.0.0-beta.2\n').prerelease[1], 2);
  assert(compareCliVersions('1.0.0-beta.2', '1.0.0-beta.3') < 0);
  assert(compareCliVersions('1.0.0-beta.10', '1.0.0-beta.3') > 0);
  assert(compareCliVersions('1.0.0', '1.0.0-beta.3') > 0);
  assert(compareCliVersions('1.1.0', '1.0.0') > 0);
});

test('fails closed for missing or non-semantic CLI versions', () => {
  assert.equal(cliVersionStatus('', '1.0.0-beta.3').supported, false);
  assert.equal(cliVersionStatus('not-a-version', '1.0.0-beta.3').supported, false);
});
