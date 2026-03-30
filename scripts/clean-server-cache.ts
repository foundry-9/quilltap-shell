#!/usr/bin/env npx tsx
/**
 * Clean Server Cache
 *
 * Removes the downloaded standalone server cache so the next launch
 * downloads and extracts a fresh copy.
 *
 * Usage:
 *   npx tsx scripts/clean-server-cache.ts
 *   npm run clean:server-cache
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

function getCacheDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Quilltap', 'standalone');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'Quilltap', 'standalone');
  }
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'quilltap', 'standalone');
}

const cacheDir = getCacheDir();

if (fs.existsSync(cacheDir)) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log(`Cleared ${cacheDir}`);
} else {
  console.log(`Nothing to clean (${cacheDir} does not exist)`);
}
