#!/usr/bin/env npx tsx
/**
 * Validate Release Tag Format
 *
 * Accepts semver-ish tags such as 4.1.3 or 4.1.0-dev.21 / 4.1.0-beta.1.
 * Refuses anything else.
 *
 * Reads the tag from (in order of preference):
 *   - first CLI argument
 *   - $GITHUB_REF_NAME (set by GitHub Actions on tag push)
 *
 * Usage:
 *   npx tsx scripts/release/validate-tag.ts            # uses $GITHUB_REF_NAME
 *   npx tsx scripts/release/validate-tag.ts 4.1.3      # explicit
 */

const TAG_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error('Error: no tag provided. Pass one as an argument or set GITHUB_REF_NAME.');
  process.exit(1);
}

if (!TAG_PATTERN.test(tag)) {
  console.error(`Tag '${tag}' is not valid semver-ish (expected 1.2.3 or 1.2.3-dev.21)`);
  process.exit(1);
}

console.log(`Tag '${tag}' looks like a valid release tag.`);
