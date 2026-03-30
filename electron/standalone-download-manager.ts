import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DownloadProgress } from './types';
import {
  STANDALONE_CACHE_DIR,
  GITHUB_REPO,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_PROGRESS_THROTTLE_MS,
} from './constants';

// Use dynamic import for tar (ESM package)
let tarExtract: (opts: { file: string; cwd: string }) => Promise<void>;
async function ensureTar() {
  if (!tarExtract) {
    const tar = await import('tar');
    tarExtract = tar.x.bind(tar);
  }
}

/**
 * Manages downloading, caching, and extracting the Quilltap standalone
 * server tarball from GitHub Releases. Also handles symlinking native
 * modules from the Electron app's node_modules into the standalone directory.
 */
export class StandaloneDownloadManager {
  private cacheDir: string;

  constructor() {
    this.cacheDir = STANDALONE_CACHE_DIR;
  }

  /** Return the cache directory path */
  getCacheDir(): string {
    return this.cacheDir;
  }

  /** Path to server.js in the cache */
  getServerPath(): string {
    return path.join(this.cacheDir, 'server.js');
  }

  /** Check if the cached standalone matches the expected version */
  isCacheValid(version: string): boolean {
    const versionFile = path.join(this.cacheDir, '.version');
    const serverJs = this.getServerPath();

    if (!fs.existsSync(serverJs)) {
      return false;
    }

    try {
      const cachedVersion = fs.readFileSync(versionFile, 'utf-8').trim();
      return cachedVersion === version;
    } catch {
      return false;
    }
  }

  /** Get the currently cached version, or null if no cache */
  getCachedVersion(): string | null {
    try {
      return fs.readFileSync(path.join(this.cacheDir, '.version'), 'utf-8').trim();
    } catch {
      return null;
    }
  }

  /** Build download URL for a specific version */
  static getDownloadUrl(version: string): string {
    return `https://github.com/${GITHUB_REPO}/releases/download/${version}/quilltap-standalone-${version}.tar.gz`;
  }

  /**
   * Query GitHub API for the latest release version.
   * @param channel - 'release' for stable, 'dev' for pre-releases
   */
  async getLatestVersion(channel: 'release' | 'dev' = 'release'): Promise<string> {
    if (channel === 'release') {
      // The /releases/latest endpoint returns the most recent non-prerelease
      const data = await this.githubApiGet(`/repos/${GITHUB_REPO}/releases/latest`);
      return data.tag_name;
    }

    // For dev, list recent releases and find the first prerelease
    const releases = await this.githubApiGet(`/repos/${GITHUB_REPO}/releases?per_page=20`);
    const prerelease = releases.find((r: { prerelease: boolean }) => r.prerelease);
    if (prerelease) {
      return prerelease.tag_name;
    }

    // Fallback to latest if no prerelease found
    const latest = await this.githubApiGet(`/repos/${GITHUB_REPO}/releases/latest`);
    return latest.tag_name;
  }

  /**
   * Ensure the standalone tarball is downloaded and extracted.
   * Returns the path to the cache directory.
   */
  async ensureStandalone(
    version: string,
    onProgress?: (progress: DownloadProgress) => void,
    options?: { force?: boolean },
  ): Promise<string> {
    if (!options?.force && this.isCacheValid(version)) {
      return this.cacheDir;
    }

    await ensureTar();

    const url = StandaloneDownloadManager.getDownloadUrl(version);
    const tarballPath = path.join(os.tmpdir(), `quilltap-standalone-${version}.tar.gz`);

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
      try {
        await this.downloadFile(url, tarballPath, onProgress);

        // Clean existing cache
        if (fs.existsSync(this.cacheDir)) {
          fs.rmSync(this.cacheDir, { recursive: true, force: true });
        }
        fs.mkdirSync(this.cacheDir, { recursive: true });

        // Extract
        await tarExtract({ file: tarballPath, cwd: this.cacheDir });

        // Write version sidecar
        fs.writeFileSync(path.join(this.cacheDir, '.version'), version, 'utf-8');

        // Clean up tarball
        try { fs.unlinkSync(tarballPath); } catch { /* ignore */ }

        return this.cacheDir;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[StandaloneDownloadManager] Attempt ${attempt}/${DOWNLOAD_MAX_RETRIES} failed: ${lastError.message}`);

        // Clean up partial downloads
        try { fs.unlinkSync(tarballPath); } catch { /* ignore */ }

        if (attempt < DOWNLOAD_MAX_RETRIES) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new Error(
      `Failed to download Quilltap server after ${DOWNLOAD_MAX_RETRIES} attempts.\n` +
      `URL: ${url}\n` +
      `Error: ${lastError ? lastError.message : 'Unknown error'}\n\n` +
      `Please check your internet connection and try again.\n` +
      `You can download manually from: https://github.com/${GITHUB_REPO}/releases`,
    );
  }

  /**
   * Symlink native modules from the Electron app's node_modules into the
   * standalone directory's node_modules, so the server can find them via
   * standard Node.js module resolution.
   */
  linkNativeModules(): void {
    const standaloneNodeModules = path.join(this.cacheDir, 'node_modules');

    if (!fs.existsSync(standaloneNodeModules)) {
      fs.mkdirSync(standaloneNodeModules, { recursive: true });
    }

    const symlinkType: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';

    const linkModule = (name: string, sourceDir: string | null): void => {
      if (!sourceDir) return;
      const targetPath = path.join(standaloneNodeModules, name);

      // If already exists and points to the right place, skip
      if (fs.existsSync(targetPath)) {
        try {
          const existing = fs.realpathSync(targetPath);
          const source = fs.realpathSync(sourceDir);
          if (existing === source) return;
        } catch {
          // If we can't resolve, remove and re-link
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
      }

      // Ensure parent directory exists (for scoped packages like @img/sharp-*)
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      try {
        fs.symlinkSync(sourceDir, targetPath, symlinkType);
        console.log(`[StandaloneDownloadManager] Linked ${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[StandaloneDownloadManager] Could not symlink ${name}: ${msg}`);
      }
    };

    // Link better-sqlite3-multiple-ciphers as 'better-sqlite3' (the server
    // imports it via npm alias)
    const betterSqlite3Dir = this.resolveModuleDir('better-sqlite3-multiple-ciphers')
                          || this.resolveModuleDir('better-sqlite3');
    linkModule('better-sqlite3', betterSqlite3Dir);

    // Link sharp
    const sharpDir = this.resolveModuleDir('sharp');
    linkModule('sharp', sharpDir);

    // Link sharp's @img platform packages
    if (sharpDir) {
      const sharpParent = path.dirname(sharpDir);
      const imgDir = path.join(sharpParent, '@img');
      if (fs.existsSync(imgDir)) {
        try {
          const imgPackages = fs.readdirSync(imgDir).filter(name => name.startsWith('sharp-'));
          for (const pkg of imgPackages) {
            linkModule(`@img/${pkg}`, path.join(imgDir, pkg));
          }
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // --- Private helpers ---

  /** Resolve a module's directory from the Electron app's node_modules */
  private resolveModuleDir(moduleName: string): string | null {
    try {
      const pkgJson = require.resolve(moduleName + '/package.json');
      return path.dirname(pkgJson);
    } catch {
      return null;
    }
  }

  /** Make a GET request to the GitHub API and parse JSON response */
  private githubApiGet(apiPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: apiPath,
        headers: {
          'User-Agent': 'quilltap-shell',
          'Accept': 'application/vnd.github.v3+json',
        },
      };

      https.get(options, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          this.githubApiGet(response.headers.location).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`GitHub API returned HTTP ${response.statusCode}`));
          return;
        }

        let body = '';
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Failed to parse GitHub API response'));
          }
        });
        response.on('error', reject);
      }).on('error', reject);
    });
  }

  /** Download a file from a URL, following redirects, with progress reporting */
  private downloadFile(
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const request = protocol.get(url, { headers: { 'User-Agent': 'quilltap-shell' } }, (response) => {
        // Handle redirects (GitHub releases redirect to S3)
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          this.downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let bytesReceived = 0;
        let lastProgressTime = 0;
        let lastProgressBytes = 0;

        const tempPath = destPath + '.tmp';
        const fileStream = fs.createWriteStream(tempPath);

        response.on('data', (chunk: Buffer) => {
          bytesReceived += chunk.length;

          const now = Date.now();
          if (onProgress && now - lastProgressTime >= DOWNLOAD_PROGRESS_THROTTLE_MS) {
            const elapsed = (now - lastProgressTime) / 1000;
            const bytesInPeriod = bytesReceived - lastProgressBytes;
            const speedBps = elapsed > 0 ? bytesInPeriod / elapsed : 0;
            const percent = totalBytes > 0 ? Math.round((bytesReceived / totalBytes) * 100) : 0;

            onProgress({
              phase: 'downloading',
              bytesReceived,
              totalBytes,
              percent,
              speed: this.formatSpeed(speedBps),
            });

            lastProgressTime = now;
            lastProgressBytes = bytesReceived;
          }
        });

        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            // Send final 100% progress
            if (onProgress && totalBytes > 0) {
              onProgress({
                phase: 'downloading',
                bytesReceived,
                totalBytes,
                percent: 100,
                speed: '',
              });
            }
            // Move temp file to final location
            fs.renameSync(tempPath, destPath);
            resolve();
          });
        });

        fileStream.on('error', (err) => {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
          reject(err);
        });

        response.on('error', reject);
      });

      request.on('error', reject);
    });
  }

  private formatSpeed(bytesPerSecond: number): string {
    if (bytesPerSecond >= 1024 * 1024) {
      return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSecond >= 1024) {
      return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    }
    return `${Math.round(bytesPerSecond)} B/s`;
  }
}
