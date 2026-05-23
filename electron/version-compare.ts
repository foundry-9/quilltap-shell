/**
 * Compare two version tags (e.g. '4.0.8', '4.1.0-dev.1').
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Compares major.minor.patch numerically, then pre-release suffixes per semver
 * precedence rules (a version without a suffix is newer than one with a suffix
 * at the same base; suffixes are compared segment-by-segment, with all-numeric
 * segments compared numerically).
 */
export function compareVersions(a: string, b: string): number {
  const stripV = (v: string) => v.replace(/^v/, '');
  const [aBase, aSuffix] = stripV(a).split('-', 2) as [string, string | undefined];
  const [bBase, bSuffix] = stripV(b).split('-', 2) as [string, string | undefined];

  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }

  // Same base version: no suffix > suffix (e.g. 4.1.0 > 4.1.0-dev.1)
  if (!aSuffix && bSuffix) return 1;
  if (aSuffix && !bSuffix) return -1;
  if (aSuffix && bSuffix) return compareSuffix(aSuffix, bSuffix);
  return 0;
}

/**
 * Compare two pre-release suffixes per semver §11.4.
 * Segments are split on '.'. Numeric segments compare numerically; alphanumeric
 * compare lexicographically; numeric < alphanumeric; a shorter prefix < longer.
 */
function compareSuffix(a: string, b: string): number {
  const aSegs = a.split('.');
  const bSegs = b.split('.');
  const len = Math.max(aSegs.length, bSegs.length);
  for (let i = 0; i < len; i++) {
    if (i >= aSegs.length) return -1;
    if (i >= bSegs.length) return 1;
    const aSeg = aSegs[i];
    const bSeg = bSegs[i];
    const aNum = /^\d+$/.test(aSeg);
    const bNum = /^\d+$/.test(bSeg);
    if (aNum && bNum) {
      const diff = Number(aSeg) - Number(bSeg);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      const cmp = aSeg.localeCompare(bSeg);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}
