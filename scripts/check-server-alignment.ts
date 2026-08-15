#!/usr/bin/env npx tsx
/**
 * Check Server Dependency Alignment
 *
 * The shell force-injects its own copies of sharp, better-sqlite3 (the
 * better-sqlite3-multiple-ciphers alias), and the @img/* binaries into every
 * extracted server tarball (see electron/standalone-download-manager.ts), so
 * the versions installed HERE are what the embedded server actually runs.
 * If they drift outside the ranges the server declares, the server executes
 * against a library version it was never built for — exactly the sharp
 * 0.34.5-vs-^0.35.3 mismatch that shipped prior to 4.1.13.
 *
 * This guard compares the shell's installed versions against the ranges
 * declared in the quilltap-server repo's package.json. The server checkout
 * is located via QUILLTAP_SERVER_DIR, falling back to a ../quilltap-server
 * sibling. An explicitly set QUILLTAP_SERVER_DIR that doesn't exist fails
 * the build; a merely absent sibling (e.g. CI without the checkout) skips
 * the check with a notice, since the tarball itself isn't wrong — only
 * unverifiable.
 *
 * @img/* packages need no check of their own: they are resolved from the
 * installed sharp's optionalDependencies and travel with it as a matched set.
 *
 * Usage:
 *   npx tsx scripts/check-server-alignment.ts
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as semver from 'semver';

const PROJECT_ROOT = join(__dirname, '..');

// Each entry: the module directory name in the shell's node_modules, the
// dependency key in the server's package.json, and (when the server declares
// it through an npm alias) the real package name the installed copy must have.
const INJECTED_MODULES: Array<{
  shellModule: string;
  serverDepKey: string;
  expectedPackageName: string;
}> = [
  { shellModule: 'sharp', serverDepKey: 'sharp', expectedPackageName: 'sharp' },
  {
    shellModule: 'better-sqlite3',
    serverDepKey: 'better-sqlite3',
    expectedPackageName: 'better-sqlite3-multiple-ciphers',
  },
];

function locateServerRepo(): string | null {
  const explicit = process.env.QUILLTAP_SERVER_DIR;
  if (explicit) {
    if (!existsSync(join(explicit, 'package.json'))) {
      console.error(
        `    ERROR: QUILLTAP_SERVER_DIR is set to ${explicit} but no package.json exists there.`,
      );
      process.exit(1);
    }
    return explicit;
  }
  const sibling = join(PROJECT_ROOT, '..', 'quilltap-server');
  return existsSync(join(sibling, 'package.json')) ? sibling : null;
}

// Server dependency values may be plain ranges ("^0.35.3") or npm aliases
// ("npm:better-sqlite3-multiple-ciphers@^12.11.1").
function parseServerDep(value: string): { packageName: string | null; range: string } {
  if (value.startsWith('npm:')) {
    const spec = value.slice('npm:'.length);
    const at = spec.lastIndexOf('@');
    return { packageName: spec.slice(0, at), range: spec.slice(at + 1) };
  }
  return { packageName: null, range: value };
}

console.log('==> Checking injected-module alignment with quilltap-server');

const serverRepo = locateServerRepo();
if (!serverRepo) {
  console.log('    NOTICE: no quilltap-server checkout found (set QUILLTAP_SERVER_DIR or');
  console.log('    clone it as a sibling directory); skipping alignment check.');
  process.exit(0);
}
console.log(`    Server repo: ${serverRepo}`);

const serverDeps: Record<string, string> =
  JSON.parse(readFileSync(join(serverRepo, 'package.json'), 'utf-8')).dependencies ?? {};

let failed = false;

for (const { shellModule, serverDepKey, expectedPackageName } of INJECTED_MODULES) {
  const serverValue = serverDeps[serverDepKey];
  if (!serverValue) {
    console.error(`    ERROR: server package.json no longer declares "${serverDepKey}" —`);
    console.error('    update INJECTED_MODULES in this script to match reality.');
    failed = true;
    continue;
  }
  const { packageName: aliasTarget, range } = parseServerDep(serverValue);

  const installedPkgPath = join(PROJECT_ROOT, 'node_modules', shellModule, 'package.json');
  if (!existsSync(installedPkgPath)) {
    console.error(`    ERROR: ${shellModule} is not installed. Run npm install first.`);
    failed = true;
    continue;
  }
  const installed = JSON.parse(readFileSync(installedPkgPath, 'utf-8'));

  if (installed.name !== expectedPackageName || (aliasTarget && aliasTarget !== installed.name)) {
    console.error(
      `    ✗ ${shellModule}: installed package is "${installed.name}" but the server` +
        ` expects "${aliasTarget ?? expectedPackageName}".`,
    );
    failed = true;
    continue;
  }

  if (!semver.satisfies(installed.version, range)) {
    console.error(
      `    ✗ ${shellModule}: installed ${installed.version} does not satisfy the` +
        ` server's declared range ${range}.`,
    );
    console.error(
      `      Fix: bump "${shellModule === 'better-sqlite3' ? 'better-sqlite3' : shellModule}"` +
        ` in the shell's package.json to match quilltap-server, then npm install.`,
    );
    failed = true;
    continue;
  }

  console.log(`    ✓ ${shellModule}: ${installed.version} satisfies server range ${range}`);
}

if (failed) {
  console.error('');
  console.error('    Injected modules are out of alignment with quilltap-server.');
  console.error('    The shell overwrites these inside every extracted server tarball,');
  console.error('    so a mismatch here ships a mismatched runtime to users.');
  process.exit(1);
}
