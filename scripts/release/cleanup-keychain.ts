#!/usr/bin/env npx tsx
/**
 * Reverse the side-effects of import-signing-cert.ts and write-apple-api-key.ts:
 * delete the temporary keychain and unlink the .p8 file.
 *
 * Reads the paths from $KEYCHAIN_PATH and $APPLE_API_KEY (set by the earlier
 * scripts). Missing values are tolerated so this is safe to run even if an
 * earlier step never ran.
 *
 * Usage:
 *   KEYCHAIN_PATH=... APPLE_API_KEY=... npx tsx scripts/release/cleanup-keychain.ts
 */

import { execFileSync } from 'child_process';
import { unlinkSync } from 'fs';

const keychainPath = process.env.KEYCHAIN_PATH;
const appleApiKey = process.env.APPLE_API_KEY;

if (keychainPath) {
  try {
    execFileSync('security', ['delete-keychain', keychainPath], { stdio: 'inherit' });
    console.log(`Deleted keychain ${keychainPath}`);
  } catch {
    console.error(`Warning: failed to delete keychain ${keychainPath}; continuing.`);
  }
} else {
  console.log('KEYCHAIN_PATH not set; nothing to delete.');
}

if (appleApiKey) {
  try {
    unlinkSync(appleApiKey);
    console.log(`Removed Apple API key file ${appleApiKey}`);
  } catch {
    console.error(`Warning: failed to remove ${appleApiKey}; continuing.`);
  }
} else {
  console.log('APPLE_API_KEY not set; nothing to remove.');
}
