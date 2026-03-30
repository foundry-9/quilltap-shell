#!/usr/bin/env npx tsx
/**
 * Rebuild Native Modules for Electron
 *
 * Rebuilds better-sqlite3 (via better-sqlite3-multiple-ciphers) and installs
 * the correct platform-specific sharp binaries so that native modules in the
 * packaged Electron app match Electron's Node ABI.
 *
 * This must run BEFORE electron-builder packages the app. The rebuilt modules
 * end up in node_modules/ and electron-builder's default asarUnpack behaviour
 * places .node files into app.asar.unpacked/.
 *
 * At runtime, the standalone download manager copies these modules into the
 * downloaded server's node_modules so they can be loaded via ELECTRON_RUN_AS_NODE.
 *
 * Usage:
 *   npx tsx scripts/rebuild-native-modules.ts
 */

import { execSync } from 'child_process';
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

// Step 1: Rebuild better-sqlite3 (aliased as better-sqlite3-multiple-ciphers)
console.log('==> Step 1/2: Rebuilding better-sqlite3-multiple-ciphers');

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
console.log('    \u2713 better-sqlite3.node rebuilt successfully');

// Step 2: Install correct platform-specific sharp binaries
console.log('==> Step 2/2: Installing platform-specific sharp binaries');

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
    console.log('    \u2713 Sharp platform binaries installed');
  } else {
    process.exit(1);
  }
}

console.log('');
console.log('==> Done! Native modules are ready for electron-builder.');
