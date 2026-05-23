#!/usr/bin/env npx tsx
/**
 * Write the Apple App Store Connect API key (.p8) to a file that the
 * notarization tooling can read, then expose its path via APPLE_API_KEY.
 *
 * Required env vars:
 *   APPLE_API_KEY_ID  the key ID, used in the file name
 *   APPLE_API_KEY_P8  the literal PEM/PKCS-8 contents of the .p8 file
 *
 * Usage:
 *   APPLE_API_KEY_ID=... APPLE_API_KEY_P8="$(cat key.p8)" \
 *     npx tsx scripts/release/write-apple-api-key.ts
 */

import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';

import { requireEnv, runnerTemp, setEnv } from './_lib';

const keyId = requireEnv('APPLE_API_KEY_ID');
const keyP8 = requireEnv('APPLE_API_KEY_P8');

const keyFile = join(runnerTemp(), `AuthKey_${keyId}.p8`);
writeFileSync(keyFile, keyP8);
chmodSync(keyFile, 0o600);

console.log(`Wrote Apple API key to ${keyFile}`);
setEnv('APPLE_API_KEY', keyFile);
