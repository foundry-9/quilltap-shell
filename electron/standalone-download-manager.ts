import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DownloadProgress, VersionOption } from './types';
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
   * Fetch available server versions from GitHub Releases, filtered to >= minVersion.
   * Returns VersionOption[] sorted newest-first. Includes both stable and prerelease.
   */
  async getAvailableVersions(minVersion: string = '3.2.0'): Promise<VersionOption[]> {
    const releases = await this.githubApiGet(`/repos/${GITHUB_REPO}/releases?per_page=100`);

    const minParts = minVersion.split('.').map(Number);

    return (releases as Array<{ tag_name: string; prerelease: boolean; assets: Array<{ name: string }> }>)
      .filter((r) => {
        // Must have a standalone tarball asset
        const hasStandalone = r.assets.some((a) => a.name.startsWith('quilltap-standalone-'));
        if (!hasStandalone) return false;

        // Filter by minimum version (compare only major.minor.patch, ignore prerelease suffix)
        const baseTag = r.tag_name.replace(/^v/, '').split('-')[0];
        const parts = baseTag.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          const a = parts[i] || 0;
          const b = minParts[i] || 0;
          if (a > b) return true;
          if (a < b) return false;
        }
        return true; // equal
      })
      .map((r): VersionOption => ({
        tag: r.tag_name,
        label: r.prerelease ? `${r.tag_name} (pre-release)` : r.tag_name,
        prerelease: r.prerelease,
      }));
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
   * Copy native modules from the Electron app into the standalone directory.
   *
   * The standalone tarball ships without native modules (they're platform-
   * specific). The Electron app bundles them in app.asar.unpacked/, rebuilt
   * at build time against Electron's Node ABI by rebuild-native-modules.ts.
   *
   * We copy (not symlink) because symlinked modules resolve their transitive
   * dependencies relative to the symlink target, where they aren't available.
   */
  linkNativeModules(): void {
    const standaloneNodeModules = path.join(this.cacheDir, 'node_modules');

    if (!fs.existsSync(standaloneNodeModules)) {
      fs.mkdirSync(standaloneNodeModules, { recursive: true });
    }

    const copyModule = (name: string, sourceDir: string | null): void => {
      if (!sourceDir) return;
      const targetPath = path.join(standaloneNodeModules, name);

      // Check if something already exists (including broken symlinks)
      let targetExists = false;
      try {
        fs.lstatSync(targetPath);
        targetExists = true;
      } catch {
        // Nothing at this path
      }

      if (targetExists) {
        // If already copied with matching version, skip
        try {
          const srcPkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8'));
          const dstPkg = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf-8'));
          if (srcPkg.version === dstPkg.version) return;
        } catch {
          // Can't compare — re-copy
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
      }

      // Ensure parent directory exists (for scoped packages like @img/sharp-*)
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      try {
        fs.cpSync(sourceDir, targetPath, { recursive: true });
        console.log(`[StandaloneDownloadManager] Copied ${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[StandaloneDownloadManager] Could not copy ${name}: ${msg}`);
      }
    };

    // Copy better-sqlite3-multiple-ciphers as 'better-sqlite3' (the server
    // imports it via npm alias)
    const betterSqlite3Dir = this.resolveModuleDir('better-sqlite3-multiple-ciphers')
                          || this.resolveModuleDir('better-sqlite3');
    copyModule('better-sqlite3', betterSqlite3Dir);

    // Copy sharp
    const sharpDir = this.resolveModuleDir('sharp');
    copyModule('sharp', sharpDir);

    // Copy sharp's @img platform packages
    if (sharpDir) {
      const sharpParent = path.dirname(sharpDir);
      const imgDir = path.join(sharpParent, '@img');
      if (fs.existsSync(imgDir)) {
        try {
          const imgPackages = fs.readdirSync(imgDir).filter(n => n.startsWith('sharp-'));
          for (const pkg of imgPackages) {
            copyModule(`@img/${pkg}`, path.join(imgDir, pkg));
          }
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // --- Private helpers ---

  /**
   * Resolve a module's directory from the Electron app's node_modules.
   * In packaged builds, native modules live in app.asar.unpacked/ rather than
   * inside the asar archive, so we rewrite the path accordingly.
   */
  private resolveModuleDir(moduleName: string): string | null {
    try {
      const pkgJson = require.resolve(moduleName + '/package.json');
      let dir = path.dirname(pkgJson);
      // In packaged Electron apps, require.resolve returns a path through
      // app.asar (virtual filesystem), but native .node binaries are extracted
      // to app.asar.unpacked/. The standalone server runs as plain Node.js
      // (ELECTRON_RUN_AS_NODE=1) and can't read from the asar archive.
      dir = dir.replace(/app\.asar([\/\\])/, 'app.asar.unpacked$1');
      return dir;
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
