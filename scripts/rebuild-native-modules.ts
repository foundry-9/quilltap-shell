#!/usr/bin/env npx tsx
/**
 * Rebuild Native Modules for Electron
 *
 * Installs the correct platform-specific sharp binaries and rebuilds
 * better-sqlite3 (via better-sqlite3-multiple-ciphers) so that native modules
 * in the packaged Electron app match Electron's Node ABI.
 *
 * This must run BEFORE electron-builder packages the app. The rebuilt modules
 * end up in node_modules/ and electron-builder's default asarUnpack behaviour
 * places .node files into app.asar.unpacked/.
 *
 * At runtime, the standalone download manager copies these modules into the
 * downloaded server's node_modules so they can be loaded via ELECTRON_RUN_AS_NODE.
 *
 * ORDER MATTERS. The sharp step shells out to `npm install`, which re-resolves
 * the dependency tree and will happily reinstall better-sqlite3 from its plain-
 * Node prebuild (the wrong ABI), silently clobbering a freshly compiled binary.
 * That is exactly how releases 4.1.5–4.1.11 shipped a NODE_MODULE_VERSION 127
 * better_sqlite3.node into an Electron that wanted 145. So sharp is installed
 * FIRST, better-sqlite3 is compiled LAST, and a final ABI guard loads the result
 * under Electron to guarantee nothing reverted it.
 *
 * Usage:
 *   npx tsx scripts/rebuild-native-modules.ts
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(__dirname, '..');

function run(cmd: string, description: string, cwd?: string): void {
  console.log(`> ${description}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: cwd || PROJECT_ROOT, env: process.env });
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

console.log('==> Rebuilding native modules for Electron');
console.log(`    Electron: ${electronVersion}`);
console.log(`    Arch:     ${targetArch}`);
console.log('');

// Step 1: Install correct platform-specific sharp binaries
//
// sharp is distributed as prebuilt platform binaries (it is not compiled here),
// so we select the right @img/* packages. This runs FIRST because the npm
// install below re-resolves the whole tree and would clobber a better-sqlite3
// rebuild. sharp's binaries are N-API, so they are ABI-independent across Node
// and Electron versions and need no rebuild.
console.log('==> Step 1/2: Installing platform-specific sharp binaries');

const sharpPkgPath = join(PROJECT_ROOT, 'node_modules', 'sharp', 'package.json');
if (!existsSync(sharpPkgPath)) {
  console.error('    ERROR: sharp not found in node_modules');
  process.exit(1);
}

const sharpPkg = JSON.parse(readFileSync(sharpPkgPath, 'utf-8'));
const sharpPlatform = process.platform === 'win32' ? 'win32' : process.platform;

// Determine which @img packages we need
const requiredPackages: { name: string; version: string }[] = [];
const optDeps: Record<string, string> = sharpPkg.optionalDependencies || {};
for (const [name, ver] of Object.entries(optDeps)) {
  if (name.includes(`${sharpPlatform}-${targetArch}`)) {
    requiredPackages.push({ name, version: ver });
  }
}

if (requiredPackages.length === 0) {
  console.warn(`    WARNING: No sharp platform packages found for ${sharpPlatform}-${targetArch}`);
} else {
  console.log(`    Platform: ${sharpPlatform}-${targetArch}`);
  console.log(`    Packages: ${requiredPackages.map(p => p.name).join(', ')}`);

  // Remove wrong-platform @img packages
  const imgDir = join(PROJECT_ROOT, 'node_modules', '@img');
  if (existsSync(imgDir)) {
    for (const entry of readdirSync(imgDir)) {
      if (entry.startsWith('sharp-') && !entry.includes(`${sharpPlatform}-${targetArch}`)) {
        const fullPath = join(imgDir, entry);
        console.log(`    Removing wrong-platform: @img/${entry}`);
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }

  // Install correct platform packages
  const installSpecs = requiredPackages.map(p => `${p.name}@${p.version}`).join(' ');
  run(
    `npm install --no-save --no-package-lock ${installSpecs}`,
    `Installing sharp binaries for ${sharpPlatform}-${targetArch}`,
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
    console.log('    ✓ Sharp platform binaries installed');
  } else {
    process.exit(1);
  }
}

// Step 2: Rebuild better-sqlite3 (aliased as better-sqlite3-multiple-ciphers)
//
// This MUST be the last mutation of node_modules: it compiles a binary against
// Electron's ABI, and any subsequent `npm install` would replace it with the
// plain-Node prebuild. node-gyp always builds from source, so the output ABI is
// correct as long as nothing reinstalls the package afterwards.
console.log('');
console.log('==> Step 2/2: Rebuilding better-sqlite3-multiple-ciphers');

// npm alias: package.json has "better-sqlite3": "npm:better-sqlite3-multiple-ciphers@..."
// so the directory is node_modules/better-sqlite3/ despite the package name
const bsqlPath = existsSync(join(PROJECT_ROOT, 'node_modules', 'better-sqlite3'))
  ? join(PROJECT_ROOT, 'node_modules', 'better-sqlite3')
  : join(PROJECT_ROOT, 'node_modules', 'better-sqlite3-multiple-ciphers');
if (!existsSync(bsqlPath)) {
  console.error('    ERROR: better-sqlite3 / better-sqlite3-multiple-ciphers not found in node_modules');
  process.exit(1);
}

const bindingGyp = join(bsqlPath, 'binding.gyp');
if (!existsSync(bindingGyp)) {
  console.error('    ERROR: binding.gyp not found — cannot rebuild');
  process.exit(1);
}

const electronDistUrl = 'https://electronjs.org/headers';
console.log(`    Using Electron headers from ${electronDistUrl}`);

run(
  [
    'npx node-gyp rebuild',
    '--release',
    `--target=${electronVersion}`,
    `--arch=${targetArch}`,
    `--dist-url=${electronDistUrl}`,
    '--build-from-source',
  ].join(' '),
  `Rebuilding better-sqlite3 for Electron ${electronVersion} (${targetArch})`,
  bsqlPath,
);

const bsqlNode = join(bsqlPath, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(bsqlNode)) {
  console.error('    ERROR: better_sqlite3.node not found after rebuild');
  process.exit(1);
}
console.log('    ✓ better-sqlite3.node rebuilt successfully');

// Step 3: Guard — verify better_sqlite3.node actually loads under Electron's
// Node ABI. This script runs under plain Node (the wrong ABI to load the addon
// directly), so we shell out to the Electron binary in ELECTRON_RUN_AS_NODE
// mode — exactly how the embedded server loads it at runtime. A clobbered or
// mistargeted binary fails here loudly instead of silently shipping (which is
// what slipped through for every Electron-41 release before 4.1.12).
console.log('');
console.log('==> Verifying better-sqlite3 against Electron ABI');

const electronBin = require('electron') as unknown as string;
const probe = spawnSync(
  electronBin,
  [
    '-e',
    "try { require(process.env.QT_ABI_PROBE); console.log('ABI ' + process.versions.modules); }"
      + ' catch (e) { console.error(String((e && e.message) || e)); process.exit(3); }',
  ],
  {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', QT_ABI_PROBE: bsqlNode },
    encoding: 'utf-8',
  },
);

const probeOut = String(probe.stdout || '');
if (probe.status !== 0 || !probeOut.includes('ABI ')) {
  console.error("    ERROR: better_sqlite3.node does not load under Electron's Node ABI.");
  console.error('    A later `npm install` likely reinstalled the plain-Node prebuild over');
  console.error('    the compiled binary. Loader output:');
  const detail = String(probe.stderr || probe.stdout || '(no output)').trim() || '(no output)';
  console.error(detail.split('\n').slice(0, 5).map((l) => `      ${l}`).join('\n'));
  process.exit(1);
}
console.log(`    ✓ better_sqlite3.node loads under Electron (NODE_MODULE_VERSION ${probeOut.trim().replace('ABI ', '')})`);

console.log('');
console.log('==> Done! Native modules are ready for electron-builder.');
