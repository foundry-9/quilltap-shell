#!/usr/bin/env npx tsx
/**
 * Run electron-builder for a single platform with the same flags the release
 * workflow uses. Always passes `--publish never`; the workflow uploads
 * artifacts and creates the GitHub release separately.
 *
 * Signing-aware fallback:
 *   - If the platform's signing credentials are present in the environment, the
 *     first attempt runs with signing enabled.
 *   - If that attempt fails (or credentials are absent on a platform that
 *     normally signs), `out/` is wiped and electron-builder is re-run with
 *     signing disabled. The resulting installer files are renamed to insert
 *     `-unsigned` before the extension, and any update-feed YAML (latest-*.yml)
 *     is patched in place to reference the new filenames.
 *   - The script only exits non-zero when neither attempt produced installers.
 *
 * The macOS build additionally injects `NODE_OPTIONS=-r ./electron/patch-fs.js`
 * to keep electron-builder's worker processes loading the same fs shim the
 * main app uses.
 *
 * Usage:
 *   npx tsx scripts/release/build-electron.ts mac
 *   npx tsx scripts/release/build-electron.ts win
 *   npx tsx scripts/release/build-electron.ts linux
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { extname, join } from 'path';

type Platform = 'mac' | 'win' | 'linux';

const PROJECT_ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(PROJECT_ROOT, 'out');

const platformArg = process.argv[2];
if (platformArg !== 'mac' && platformArg !== 'win' && platformArg !== 'linux') {
  console.error('Usage: build-electron.ts <mac|win|linux>');
  process.exit(1);
}
const platform: Platform = platformArg;

// Env vars that, when ALL are populated, indicate signing should be attempted
// for a given platform. Empty array = platform never signs (Linux).
const SIGNING_VARS: Record<Platform, string[]> = {
  mac: ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY_ID', 'APPLE_API_KEY_ISSUER'],
  win: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
  linux: [],
};

// File extensions whose artifacts get the `-unsigned` suffix on fallback.
const INSTALLER_EXTS: Record<Platform, string[]> = {
  mac: ['.dmg', '.zip'],
  win: ['.exe'],
  linux: [],
};

// Auto-updater feed filenames that need their `url:` / `path:` references
// updated after a rename.
const UPDATE_FEEDS: Record<Platform, string[]> = {
  mac: ['latest-mac.yml'],
  win: ['latest.yml'],
  linux: ['latest-linux.yml'],
};

const platformSigningVars = SIGNING_VARS[platform];
const signingExpected = platformSigningVars.length > 0;
const signingAvailable = signingExpected && platformSigningVars.every((v) => process.env[v]);

function runElectronBuilder(signed: boolean): number {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (platform === 'mac') {
    env.NODE_OPTIONS = '-r ./electron/patch-fs.js';
    if (env.DEBUG === undefined) env.DEBUG = 'electron-notarize*';
  }

  if (!signed) {
    for (const v of platformSigningVars) delete env[v];
    if (platform === 'mac') {
      env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
      delete env.APPLE_API_KEY;
      delete env.CSC_NAME;
      delete env.CODESIGN_IDENTITY;
    }
  }

  const args = [`--${platform}`, '--publish', 'never'];
  console.log(`Running: npx electron-builder ${args.join(' ')} (signed=${signed})`);
  // On Windows, `npx` is `npx.cmd`; Node's `spawn` won't resolve `.cmd` shims
  // without `shell: true`, so without this the process fails with ENOENT and
  // electron-builder never actually runs.
  const result = spawnSync('npx', ['electron-builder', ...args], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`Failed to spawn npx: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function cleanOutDir(): void {
  if (existsSync(OUT_DIR)) {
    console.log(`Cleaning ${OUT_DIR} before unsigned retry`);
    rmSync(OUT_DIR, { recursive: true, force: true });
  }
}

function renameUnsignedArtifacts(): void {
  const exts = INSTALLER_EXTS[platform];
  if (exts.length === 0 || !existsSync(OUT_DIR)) return;

  const renames: Array<{ from: string; to: string }> = [];
  for (const name of readdirSync(OUT_DIR)) {
    const ext = extname(name);
    if (!exts.includes(ext)) continue;
    if (name.endsWith(`-unsigned${ext}`)) continue;
    const newName = `${name.slice(0, -ext.length)}-unsigned${ext}`;
    renameSync(join(OUT_DIR, name), join(OUT_DIR, newName));
    renames.push({ from: name, to: newName });
    console.log(`Renamed ${name} -> ${newName}`);
  }

  if (renames.length === 0) return;

  for (const feed of UPDATE_FEEDS[platform]) {
    const feedPath = join(OUT_DIR, feed);
    if (!existsSync(feedPath)) continue;
    let text = readFileSync(feedPath, 'utf8');
    for (const { from, to } of renames) {
      text = text.split(from).join(to);
    }
    writeFileSync(feedPath, text);
    console.log(`Patched ${feed} to reference unsigned filenames`);
  }
}

if (signingAvailable) {
  if (runElectronBuilder(true) === 0) {
    console.log(`Signed ${platform} build succeeded.`);
    process.exit(0);
  }
  console.warn(`Signed ${platform} build failed — retrying without signing.`);
  cleanOutDir();
} else if (signingExpected) {
  console.warn(`Signing credentials not provided for ${platform}; building unsigned.`);
}

if (runElectronBuilder(false) !== 0) {
  console.error(
    signingExpected
      ? `Both signed and unsigned ${platform} builds failed.`
      : `${platform} build failed.`,
  );
  process.exit(1);
}

renameUnsignedArtifacts();
console.log(signingExpected ? `Unsigned ${platform} build succeeded.` : `${platform} build succeeded.`);
