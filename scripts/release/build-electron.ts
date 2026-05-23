#!/usr/bin/env npx tsx
/**
 * Run electron-builder for a single platform with the same flags the release
 * workflow uses. Always passes `--publish never`; the workflow uploads
 * artifacts and creates the GitHub release separately.
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
import { join } from 'path';

const PROJECT_ROOT = join(__dirname, '..', '..');

const platform = process.argv[2];
if (!platform || !['mac', 'win', 'linux'].includes(platform)) {
  console.error('Usage: build-electron.ts <mac|win|linux>');
  process.exit(1);
}

const args = [`--${platform}`, '--publish', 'never'];

const env: NodeJS.ProcessEnv = { ...process.env };
if (platform === 'mac') {
  env.NODE_OPTIONS = '-r ./electron/patch-fs.js';
  if (env.DEBUG === undefined) {
    env.DEBUG = 'electron-notarize*';
  }
}

console.log(`Running: npx electron-builder ${args.join(' ')}`);
const result = spawnSync('npx', ['electron-builder', ...args], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  env,
});

if (result.status !== 0) {
  console.error(`electron-builder exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}
