#!/usr/bin/env npx tsx
/**
 * Import Apple Developer ID signing certificate into a temporary keychain.
 *
 * macOS only. Used by the release workflow to make the Developer ID identity
 * available to codesign / electron-builder / productbuild without polluting
 * the user's login keychain. Locally, this script can be used to reproduce
 * a CI-style keychain when diagnosing notarization issues — but it does need
 * real CSC_LINK / CSC_KEY_PASSWORD values.
 *
 * Required env vars:
 *   CSC_LINK          base64-encoded .p12 certificate bundle
 *   CSC_KEY_PASSWORD  password protecting the .p12
 *
 * On success, sets KEYCHAIN_PATH and KEYCHAIN_PASSWORD in $GITHUB_ENV
 * (or just prints them locally). The cleanup-keychain.ts script reverses this.
 *
 * Usage:
 *   CSC_LINK=... CSC_KEY_PASSWORD=... npx tsx scripts/release/import-signing-cert.ts
 */

import { execFileSync, execSync } from 'child_process';
import { unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

import { requireEnv, runnerTemp, setEnv } from './_lib';

if (process.platform !== 'darwin') {
  console.error('Error: import-signing-cert.ts is macOS-only.');
  process.exit(1);
}

const cscLink = requireEnv('CSC_LINK');
const cscKeyPassword = requireEnv('CSC_KEY_PASSWORD');

const certFile = join(tmpdir(), `certificate.${randomBytes(6).toString('hex')}.p12`);
try {
  writeFileSync(certFile, Buffer.from(cscLink, 'base64'));

  const keychainPath = join(runnerTemp(), 'build.keychain');
  const keychainPassword = randomBytes(24).toString('base64');

  console.log(`Creating temporary keychain at ${keychainPath}`);

  execFileSync('security', ['create-keychain', '-p', keychainPassword, keychainPath], { stdio: 'inherit' });
  execFileSync('security', ['set-keychain-settings', '-lut', '21600', keychainPath], { stdio: 'inherit' });
  execFileSync('security', ['unlock-keychain', '-p', keychainPassword, keychainPath], { stdio: 'inherit' });

  execFileSync(
    'security',
    [
      'import', certFile,
      '-k', keychainPath,
      '-P', cscKeyPassword,
      '-T', '/usr/bin/codesign',
      '-T', '/usr/bin/productbuild',
      '-T', '/usr/bin/security',
      '-f', 'pkcs12',
    ],
    { stdio: 'inherit' },
  );

  execFileSync(
    'security',
    [
      'set-key-partition-list',
      '-S', 'apple-tool:,apple:,codesign:',
      '-s',
      '-k', keychainPassword,
      keychainPath,
    ],
    { stdio: 'inherit' },
  );

  // Make the new keychain the default search list (alongside existing ones).
  const existing = execSync('security list-keychains -d user', { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  execFileSync('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...existing], { stdio: 'inherit' });

  execFileSync('security', ['unlock-keychain', '-p', keychainPassword, keychainPath], { stdio: 'inherit' });

  setEnv('KEYCHAIN_PATH', keychainPath);
  setEnv('KEYCHAIN_PASSWORD', keychainPassword);

  console.log('Signing certificate imported successfully.');
} finally {
  try { unlinkSync(certFile); } catch { /* ignore */ }
}
