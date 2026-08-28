import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

// --- Standalone server download ---

/** GitHub repository for release asset URLs */
export const GITHUB_REPO = 'foundry-9/quilltap-server';

/** Directory where the standalone server tarball is cached (extracted) */
export const STANDALONE_CACHE_DIR = (() => {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Quilltap', 'standalone');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'Quilltap', 'standalone');
  }
  // Linux
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'quilltap', 'standalone');
})();

/** Build the download URL for a standalone tarball version */
export function standaloneDownloadUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${version}/quilltap-standalone-${version}.tar.gz`;
}

// --- Shared constants ---

/** Host port that maps to the server port */
export const HOST_PORT = 5050;

/** Health endpoint URL */
export const HEALTH_URL = `http://localhost:${HOST_PORT}/api/health`;

/** Milliseconds between health polls */
export const HEALTH_POLL_INTERVAL_MS = 2000;

/** Maximum health poll attempts before timeout (2 minutes at 2s intervals) */
export const HEALTH_MAX_ATTEMPTS = 60;

/**
 * Derive a deterministic Docker container name from an absolute data
 * directory path. Produces names like `quilltap-a1b2c3d4e5f6`.
 */
export function containerNameForDir(dirPath: string): string {
  const hash = crypto.createHash('sha256').update(dirPath).digest('hex').slice(0, 12);
  return `quilltap-${hash}`;
}

/** Default data directory per platform */
export const DEFAULT_DATA_DIR = (() => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
      || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Quilltap');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Quilltap');
  }
  // Linux fallback
  return path.join(os.homedir(), '.quilltap');
})();

/** Splash window dimensions */
export const SPLASH_WIDTH = 580;
export const SPLASH_HEIGHT = 770;

/** Main window dimensions */
export const MAIN_WIDTH = 1200;
export const MAIN_HEIGHT = 800;

/** Docker image name on Docker Hub */
export const DOCKER_IMAGE = 'foundry9/quilltap';

/** Port the Quilltap container listens on internally */
export const DOCKER_CONTAINER_PORT = 3000;

/** Download progress throttle (ms) */
export const DOWNLOAD_PROGRESS_THROTTLE_MS = 500;

/** Maximum download retry attempts */
export const DOWNLOAD_MAX_RETRIES = 3;

/** App version read from package.json */
export const APP_VERSION = (() => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version as string;
  } catch {
    return '';
  }
})();

/**
 * Comma-delimited capability flags advertised to the Quilltap server via the
 * QUILLTAP_SHELL_CAPABILITIES environment variable.  Add new flags here when
 * the shell gains functionality the server needs to know about (e.g.
 * "OPENS_FS_PATH", "DOWNLOADS_FILE").
 */
export const SHELL_CAPABILITIES = 'SPELLCHECK_DICTIONARY';
