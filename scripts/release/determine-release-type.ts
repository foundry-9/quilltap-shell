#!/usr/bin/env npx tsx
/**
 * Decide whether the tag at HEAD should produce a "production" release
 * (`prerelease=false`) or a "prerelease" on GitHub:
 *
 *   - Production:   tag is clean semver (e.g. 4.1.3) AND HEAD is reachable from origin/main
 *   - Prerelease:   any other case (suffixed tag, or not on main)
 *
 * Writes `prerelease=true|false` to $GITHUB_OUTPUT and echoes a human-readable
 * summary. Locally it just prints the decision.
 *
 * Reads the tag from (in order):
 *   - first CLI argument
 *   - $GITHUB_REF_NAME
 *
 * Usage:
 *   npx tsx scripts/release/determine-release-type.ts            # uses $GITHUB_REF_NAME
 *   npx tsx scripts/release/determine-release-type.ts 4.1.3
 */

import { execSync } from 'child_process';

import { setOutput } from './_lib';

const CLEAN_TAG_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('Error: no tag provided. Pass one as an argument or set GITHUB_REF_NAME.');
  process.exit(1);
}

const cleanTag = CLEAN_TAG_PATTERN.test(tag);

let onMain = false;
try {
  const branches = execSync('git branch -r --contains HEAD', { encoding: 'utf8' });
  onMain = /\borigin\/main\b/.test(branches);
} catch {
  // No remote / detached repo — treat as not-on-main.
  onMain = false;
}

const prerelease = !(cleanTag && onMain);

setOutput('prerelease', String(prerelease));

if (prerelease) {
  console.log(`Release type: prerelease (clean_tag=${cleanTag}, on_main=${onMain})`);
} else {
  console.log('Release type: production');
}
