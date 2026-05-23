#!/usr/bin/env npx tsx
/**
 * Assemble the release body, collect built artifacts, and create the GitHub
 * release via `gh release create`.
 *
 * Artifact requirements:
 *   - All three platforms (macOS, Windows, Linux) must contribute at least one
 *     installer — signed or unsigned. A platform with zero installers fails
 *     the release. Signed and unsigned installers are produced by the same
 *     workflow step (see build-electron.ts); unsigned files carry an
 *     `-unsigned` suffix before their extension.
 *   - If any unsigned artifact is present, a notice is prepended to the
 *     release body.
 *
 * Reads:
 *   tag             from first CLI arg or $GITHUB_REF_NAME
 *   prerelease      from $PRERELEASE ("true" / "false"); default false
 *   artifacts dir   from $ARTIFACTS_DIR; default "artifacts"
 *   dry run         pass --dry-run to skip `gh release create`
 *
 * Required tool: `gh` CLI authenticated as a user / token with write access.
 *
 * Usage:
 *   GITHUB_REF_NAME=4.1.3 PRERELEASE=false GH_TOKEN=... \
 *     npx tsx scripts/release/create-github-release.ts
 *
 *   # local dry run against a folder of downloaded artifacts
 *   ARTIFACTS_DIR=./local-artifacts \
 *     npx tsx scripts/release/create-github-release.ts 4.1.3 --dry-run
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

const RELEASE_BODY = `## Installation

### macOS

1. Download the \`.dmg\` file and open it
2. Drag **Quilltap** to your Applications folder
3. Launch Quilltap from Applications

### Windows

1. Download and run the \`.exe\` installer
2. Follow the installation prompts
3. Launch Quilltap from the Start Menu or desktop shortcut

### Linux

1. Download the \`.AppImage\` file, make it executable (\`chmod +x\`), and run it
2. Or install the \`.deb\` package: \`sudo dpkg -i quilltap_*.deb\`
`;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));

const tag = positional[0] || process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('Error: no tag provided. Pass one as an argument or set GITHUB_REF_NAME.');
  process.exit(1);
}

const prerelease = (process.env.PRERELEASE || '').toLowerCase() === 'true';
const artifactsDir = process.env.ARTIFACTS_DIR || 'artifacts';

function glob(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(predicate).map((name) => join(dir, name)).sort();
}

const macDir = join(artifactsDir, 'electron-mac');
const winDir = join(artifactsDir, 'electron-win');
const linuxDir = join(artifactsDir, 'electron-linux');

const macAssets = [
  ...glob(macDir, (n) => n.endsWith('.dmg')),
  ...glob(macDir, (n) => n.endsWith('.zip')),
  ...glob(macDir, (n) => n === 'latest-mac.yml'),
];

const linuxAssets = [
  ...glob(linuxDir, (n) => n.endsWith('.AppImage')),
  ...glob(linuxDir, (n) => n.endsWith('.deb')),
  ...glob(linuxDir, (n) => n === 'latest-linux.yml'),
];

const winAssets = [
  ...glob(winDir, (n) => n.endsWith('.exe')),
  ...glob(winDir, (n) => n === 'latest.yml'),
];

const missing: string[] = [];
if (macAssets.length === 0) missing.push(`macOS (${macDir})`);
if (winAssets.length === 0) missing.push(`Windows (${winDir})`);
if (linuxAssets.length === 0) missing.push(`Linux (${linuxDir})`);
if (missing.length > 0) {
  console.error('Error: no installers were produced for the following platform(s):');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Every platform must produce at least one installer (signed or unsigned) for the release to proceed.');
  process.exit(1);
}

const assets = [...macAssets, ...linuxAssets, ...winAssets];

function isUnsigned(filePath: string): boolean {
  return /-unsigned\.[^./]+$/.test(basename(filePath));
}

const unsignedPlatforms: string[] = [];
if (macAssets.some(isUnsigned)) unsignedPlatforms.push('macOS');
if (winAssets.some(isUnsigned)) unsignedPlatforms.push('Windows');
if (linuxAssets.some(isUnsigned)) unsignedPlatforms.push('Linux');

const UNSIGNED_NOTICE = (platforms: string[]): string => `## A Word of Caution, Old Sport

This release arrives bearing one or more installers that, owing to the
misadventures of our code-signing apparatus, we were unable to dress in the
proper signed regalia. The files in question wear an \`-unsigned\` suffix
upon their lapel, plain as the day is long.

They are entirely functional, but your operating system — ever the
discerning doorman — may eye them with the suspicion reserved for an
uninvited guest at a Long Island garden party. To wave them past the
velvet rope:

- **macOS:** right-click the \`.dmg\` and select **Open**, then humour the dialogue. Or run \`xattr -d com.apple.quarantine /Applications/Quilltap.app\` after installing.
- **Windows:** SmartScreen will likely protest. Click **More info**, then **Run anyway**.

Platforms affected: ${platforms.join(', ')}.

---

`;

const bodyDir = mkdtempSync(join(tmpdir(), 'release-body-'));
const bodyFile = join(bodyDir, 'release-body.md');
const body = unsignedPlatforms.length > 0
  ? UNSIGNED_NOTICE(unsignedPlatforms) + RELEASE_BODY
  : RELEASE_BODY;
writeFileSync(bodyFile, body);

const ghArgs = [
  'release', 'create', tag,
  '--title', `Quilltap Shell ${tag}`,
  '--notes-file', bodyFile,
];
if (prerelease) ghArgs.push('--prerelease');
ghArgs.push(...assets);

console.log(`Creating release '${tag}' (prerelease=${prerelease})`);
console.log(`Assets (${assets.length}):`);
for (const a of assets) console.log(`  ${a}`);

if (dryRun) {
  console.log('\n(dry-run) would invoke:');
  console.log(`  gh ${ghArgs.join(' ')}`);
  process.exit(0);
}

const result = spawnSync('gh', ghArgs, { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`gh release create exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}
