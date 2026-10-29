#!/usr/bin/env npx tsx
/**
 * Select Native Modules for Electron
 *
 * Selects the prebuilt N-API binaries for the build platform and probes the SQLite
 * driver under Electron. The three native dependencies are handled as follows:
 *
 * - sharp and @napi-rs/canvas are distributed as per-platform prebuilt packages. Step 1
 *   installs the one that matches this platform and removes the rest.
 * - better-sqlite3-multiple-ciphers (aliased as better-sqlite3) ships a prebuilt
 *   N-API binary for every platform inside its npm tarball. Step 2 keeps only the
 *   prebuild for this platform and removes the compile-time sources.
 * - Step 3 loads the driver under Electron's Node, the same way the embedded server
 *   loads it at runtime, and checks that the loader picked the right binary.
 *
 * Step 1's `npm install --no-save` re-extracts any package it re-resolves, so the prune
 * in Step 2 must run after it.
 *
 * This must run BEFORE electron-builder packages the app. The selected modules end up
 * in node_modules/ and electron-builder's default asarUnpack behaviour places .node
 * files into app.asar.unpacked/.
 *
 * At runtime, the standalone download manager copies these modules into the
 * downloaded server's node_modules so they can be loaded via ELECTRON_RUN_AS_NODE.
 *
 * Usage:
 *   npx tsx scripts/select-native-modules.ts
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(__dirname, '..');

// `npm run` exports user-level npm config into the environment as
// `npm_config_*`. A nested `npm install` treats an inherited
// `npm_config_allow_scripts` as if `--allow-scripts` were passed on the command
// line, which npm 11.18+ rejects in project installs (EALLOWSCRIPTS). Drop it so
// the project's own `allowScripts` in package.json governs the nested install.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_allow_scripts'),
);

function run(cmd: string, description: string, cwd?: string): void {
  console.log(`> ${description}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: cwd || PROJECT_ROOT, env: childEnv });
  } catch {
    console.error(`Failed: ${description}`);
    process.exit(1);
  }
}

// Read Electron version from installed package
const electronPkgPath = join(PROJECT_ROOT, 'node_modules', 'electron', 'package.json');
if (!existsSync(electronPkgPath)) {
  console.error('Error: electron not found in node_modules. Run npm install first.');
  process.exit(1);
}
const electronVersion: string = JSON.parse(readFileSync(electronPkgPath, 'utf-8')).version;
const targetArch = process.arch;

console.log('==> Selecting native modules for Electron');
console.log(`    Electron: ${electronVersion}`);
console.log(`    Arch:     ${targetArch}`);
console.log('');

// Step 1/3: Install correct platform-specific prebuilt binaries
//
// sharp and @napi-rs/canvas are distributed as prebuilt N-API binaries in
// per-platform packages (they are not compiled here), so we select the right
// ones. N-API binaries work across Node and Electron versions without
// recompilation. This runs before Step 2 because the npm install below
// re-resolves the whole tree and may re-extract better-sqlite3, which would
// undo the prune.
console.log('==> Step 1/3: Installing platform-specific prebuilt binaries');

const targetPlatform = process.platform;

// @napi-rs/canvas suffixes its platform packages with the toolchain/libc;
// Electron ships for MSVC on Windows and glibc on Linux.
const canvasTarget =
  targetPlatform === 'win32' ? `win32-${targetArch}-msvc`
  : targetPlatform === 'linux' ? `linux-${targetArch}-gnu`
  : `${targetPlatform}-${targetArch}`;

// Each entry: the wrapper package, the scope directory its platform packages
// live in, the prefix those packages share, and how to recognise the ones this
// platform needs.
const PREBUILT_MODULES: Array<{
  wrapper: string;
  scope: string;
  binaryPrefix: string;
  isTargetPackage: (name: string) => boolean;
}> = [
  {
    wrapper: 'sharp',
    scope: '@img',
    binaryPrefix: 'sharp-',
    // Matches both sharp-<platform>-<arch> and sharp-libvips-<platform>-<arch>.
    isTargetPackage: (name) => name.includes(`${targetPlatform}-${targetArch}`),
  },
  {
    wrapper: '@napi-rs/canvas',
    scope: '@napi-rs',
    binaryPrefix: 'canvas-',
    isTargetPackage: (name) => name === `@napi-rs/canvas-${canvasTarget}`,
  },
];

console.log(`    Platform: ${targetPlatform}-${targetArch}`);

const requiredPackages: { name: string; version: string }[] = [];
for (const { wrapper, scope, binaryPrefix, isTargetPackage } of PREBUILT_MODULES) {
  const wrapperPkgPath = join(PROJECT_ROOT, 'node_modules', ...wrapper.split('/'), 'package.json');
  if (!existsSync(wrapperPkgPath)) {
    console.error(`    ERROR: ${wrapper} not found in node_modules`);
    process.exit(1);
  }

  const optDeps: Record<string, string> =
    JSON.parse(readFileSync(wrapperPkgPath, 'utf-8')).optionalDependencies || {};
  const modulePackages = Object.entries(optDeps)
    .filter(([name]) => isTargetPackage(name))
    .map(([name, version]) => ({ name, version }));

  if (modulePackages.length === 0) {
    console.error(`    ERROR: No ${wrapper} platform packages found for ${targetPlatform}-${targetArch}`);
    process.exit(1);
  }
  console.log(`    ${wrapper}: ${modulePackages.map(p => p.name).join(', ')}`);
  requiredPackages.push(...modulePackages);

  // Remove wrong-platform packages
  const scopeDir = join(PROJECT_ROOT, 'node_modules', scope);
  if (existsSync(scopeDir)) {
    for (const entry of readdirSync(scopeDir)) {
      if (entry.startsWith(binaryPrefix) && !isTargetPackage(`${scope}/${entry}`)) {
        console.log(`    Removing wrong-platform: ${scope}/${entry}`);
        rmSync(join(scopeDir, entry), { recursive: true, force: true });
      }
    }
  }
}

// Install correct platform packages in one pass, so no install prunes another's
const installSpecs = requiredPackages.map(p => `${p.name}@${p.version}`).join(' ');
run(
  `npm install --no-save --no-package-lock ${installSpecs}`,
  `Installing prebuilt binaries for ${targetPlatform}-${targetArch}`,
);

// Verify
let allFound = true;
for (const pkg of requiredPackages) {
  const pkgDir = join(PROJECT_ROOT, 'node_modules', ...pkg.name.split('/'));
  if (!existsSync(pkgDir)) {
    console.error(`    ERROR: ${pkg.name} not found after install`);
    allFound = false;
  }
}
if (allFound) {
  console.log('    ✓ Prebuilt platform binaries installed');
} else {
  process.exit(1);
}

// Step 2/3: Prune the SQLite driver to this platform's prebuild
//
// The driver ships eight prebuilds, one per platform and arch, plus the C++ and
// SQLite sources used to compile them. The shell needs only the prebuild for the
// platform it is building on, so everything else is removed.
console.log('');
console.log('==> Step 2/3: Pruning better-sqlite3-multiple-ciphers to this platform');

// npm alias: package.json declares "better-sqlite3": "npm:better-sqlite3-multiple-ciphers@…"
// so the directory is node_modules/better-sqlite3 despite the package name.
const bsqlPath = join(PROJECT_ROOT, 'node_modules', 'better-sqlite3');
if (!existsSync(bsqlPath)) {
  console.error('    ERROR: node_modules/better-sqlite3 not found. Run npm install first.');
  process.exit(1);
}

const driverManifest = JSON.parse(readFileSync(join(bsqlPath, 'package.json'), 'utf-8'));
if (driverManifest.name !== 'better-sqlite3-multiple-ciphers') {
  console.error(
    `    ERROR: node_modules/better-sqlite3 is "${driverManifest.name}", expected "better-sqlite3-multiple-ciphers".`,
  );
  process.exit(1);
}

const prebuildsDir = join(bsqlPath, 'prebuilds');
const keepPrebuild = `${process.platform}-${process.arch}.node`;
if (!existsSync(join(prebuildsDir, keepPrebuild))) {
  console.error(`    ERROR: no SQLite driver prebuild named ${keepPrebuild} for ${targetPlatform}-${targetArch}.`);
  console.error('    This means the platform is unsupported, not that this script is broken. Prebuilds present:');
  console.error(readdirSync(prebuildsDir).map((f) => `      ${f}`).join('\n'));
  process.exit(1);
}

const keptPrebuilds: string[] = [];
const removedPrebuilds: string[] = [];
for (const entry of readdirSync(prebuildsDir)) {
  if (entry === keepPrebuild) {
    keptPrebuilds.push(entry);
  } else {
    // The shell targets glibc Linux only (AppImage and deb built on ubuntu-latest), so
    // linuxmusl-* prebuilds are always pruned on Linux. process.platform is "linux" on
    // both glibc and musl hosts, so the choice is not special-cased here.
    rmSync(join(prebuildsDir, entry), { force: true });
    removedPrebuilds.push(entry);
  }
}

// Compile-time-only payload: about 13 MB of sqlite3.c plus the C++ sources and gyp file.
// `build/` is a leftover from a v12-era checkout and would otherwise ship a stale binary.
const compileOnlyPaths = ['deps', 'src', 'binding.gyp', 'build'];
for (const rel of compileOnlyPaths) {
  rmSync(join(bsqlPath, rel), { recursive: true, force: true });
}

const listPrebuilds = (names: string[]) => (names.length ? names.map((n) => `prebuilds/${n}`).join(', ') : '(none)');
console.log(`    Kept:    ${listPrebuilds(keptPrebuilds)}`);
console.log(`    Removed: ${listPrebuilds(removedPrebuilds)}`);
console.log(`    Removed: ${compileOnlyPaths.join(', ')}`);
console.log('    ✓ SQLite driver pruned to this platform');

// Step 3/3: Probe the driver under Electron
//
// Loads the package directory, so the driver's own platform detection (lib/binding.js,
// reached through main) runs under Electron's Node. The probe opens an in-memory
// database and reports the cipher and SQLite versions.
console.log('');
console.log('==> Step 3/3: Probing the SQLite driver under Electron');

const electronBin = require('electron') as unknown as string;
const probe = spawnSync(
  electronBin,
  [
    '-e',
    "try { const Database = require(process.env.QT_DRIVER_DIR);"
      + " const db = new Database(':memory:');"
      + " const cipher = db.pragma('cipher', { simple: true });"
      + " const sqlite = db.prepare('select sqlite_version() as v').get().v;"
      + " console.log('driver ok cipher=' + cipher + ' sqlite=' + sqlite + ' abi=' + process.versions.modules); }"
      + ' catch (e) { console.error(String((e && e.message) || e)); process.exit(3); }',
  ],
  {
    cwd: PROJECT_ROOT,
    env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1', QT_DRIVER_DIR: bsqlPath },
    encoding: 'utf-8',
  },
);

const probeOut = String(probe.stdout || '');
const probeLine = probeOut.split('\n').find((l) => l.startsWith('driver ok ')) || '';
const probeMatch = /^driver ok cipher=(\S+) sqlite=(\S+) abi=(\S+)$/.exec(probeLine.trim());

if (probe.status !== 0 || !probeMatch || probeMatch[1] !== 'chacha20') {
  console.error('    ERROR: the prebuild for this platform did not load under Electron\'s Node.');
  if (probe.status === 0 && probeMatch && probeMatch[1] !== 'chacha20') {
    console.error(`    The driver loaded but reports cipher=${probeMatch[1]}, expected chacha20.`);
    console.error('    The package may not be the multiple-ciphers build.');
  }
  console.error('    Loader output:');
  const detail = String(probe.stderr || probe.stdout || '(no output)').trim() || '(no output)';
  console.error(detail.split('\n').slice(0, 5).map((l) => `      ${l}`).join('\n'));
  process.exit(1);
}

const [, probeCipher, probeSqlite, probeAbi] = probeMatch;
console.log(`    ✓ better-sqlite3-multiple-ciphers ${driverManifest.version} loads under Electron`
  + ` (cipher=${probeCipher}, SQLite ${probeSqlite}, NODE_MODULE_VERSION ${probeAbi})`);

console.log('');
console.log('==> Done! Native modules are selected and ready for electron-builder.');
