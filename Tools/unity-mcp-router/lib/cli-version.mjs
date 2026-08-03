const SEMVER = /(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[^\s]+)?(?:$|[^0-9A-Za-z.-])/;

export function parseCliVersion(value) {
  const match = String(value ?? '').match(SEMVER);
  if (!match) return null;
  return Object.freeze({
    raw: match[0].trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part) : [],
  });
}

function compareIdentifier(left, right) {
  if (left === right) return 0;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return String(left).localeCompare(String(right));
}

export function compareCliVersions(leftValue, rightValue) {
  const left = typeof leftValue === 'object' ? leftValue : parseCliVersion(leftValue);
  const right = typeof rightValue === 'object' ? rightValue : parseCliVersion(rightValue);
  if (!left || !right) throw new TypeError('Both Unity CLI versions must be semantic versions');
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (compared) return compared;
  }
  return 0;
}

export function cliVersionStatus(actualValue, minimumValue = '1.0.0-beta.3') {
  const actual = parseCliVersion(actualValue);
  const minimum = parseCliVersion(minimumValue);
  if (!minimum) throw new TypeError(`Invalid minimum Unity CLI version: ${minimumValue}`);
  return Object.freeze({
    actual: actualValue || 'unknown',
    minimum: minimumValue,
    parsed: actual != null,
    supported: actual != null && compareCliVersions(actual, minimum) >= 0,
  });
}
