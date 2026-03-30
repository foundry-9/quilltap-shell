import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DownloadProgress, RuntimeMode, VersionOption } from './types';
import {
  STANDALONE_CACHE_DIR,
  GITHUB_REPO,
  ROOTFS_FILENAME,
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
 * Recursively copy a directory using individual fs.readFileSync/writeFileSync calls.
 * Unlike fs.cpSync, this works when the source is inside an asar archive because
 * Electron patches readFileSync/readdirSync/statSync to read from asar transparently.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.writeFileSync(destPath, fs.readFileSync(srcPath));
    }
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
  async getAvailableVersions(minVersion: string = '3.2.0', mode?: RuntimeMode): Promise<VersionOption[]> {
    const releases = await this.githubApiGet(`/repos/${GITHUB_REPO}/releases?per_page=100`);

    const minParts = minVersion.split('.').map(Number);

    return (releases as Array<{ tag_name: string; prerelease: boolean; assets: Array<{ name: string }> }>)
      .filter((r) => {
        // Filter by available assets for the requested runtime mode
        if (mode === 'docker') {
          // All tagged releases are assumed to have Docker images
        } else if (mode === 'vm') {
          const hasRootfs = r.assets.some((a: { name: string }) => a.name === ROOTFS_FILENAME);
          if (!hasRootfs) return false;
        } else {
          // Default (embedded): must have a standalone tarball asset
          const hasStandalone = r.assets.some((a) => a.name.startsWith('quilltap-standalone-'));
          if (!hasStandalone) return false;
        }

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

    const copyModule = (name: string, sourceDir: string | null, forceOverwrite = false): void => {
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
        if (!forceOverwrite) {
          // For pure-JS modules, skip if version matches
          try {
            const srcPkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8'));
            const dstPkg = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf-8'));
            if (srcPkg.version === dstPkg.version) return;
          } catch {
            // Can't compare — re-copy
          }
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
      }

      // Ensure parent directory exists (for scoped packages like @img/sharp-*)
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      try {
        copyDirRecursive(sourceDir, targetPath);
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
    console.log(`[StandaloneDownloadManager] better-sqlite3 resolved to: ${betterSqlite3Dir ?? 'null'}`);
    copyModule('better-sqlite3', betterSqlite3Dir, true);

    // Copy sharp (contains native bindings)
    const sharpDir = this.resolveModuleDir('sharp');
    console.log(`[StandaloneDownloadManager] sharp resolved to: ${sharpDir ?? 'null'}`);
    copyModule('sharp', sharpDir, true);

    // Copy all @img packages (platform-specific sharp binaries + shared deps like @img/colour)
    if (sharpDir) {
      const sharpParent = path.dirname(sharpDir);
      const imgDir = path.join(sharpParent, '@img');
      if (fs.existsSync(imgDir)) {
        try {
          const imgPackages = fs.readdirSync(imgDir);
          for (const pkg of imgPackages) {
            copyModule(`@img/${pkg}`, path.join(imgDir, pkg), true);
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
   *
   * In packaged builds, require.resolve returns paths through app.asar
   * (virtual filesystem). Electron's patched fs module can read from asar
   * transparently, so we use the asar path directly for copying.
   *
   * For modules with native .node binaries, electron-builder extracts them
   * to app.asar.unpacked/. We prefer the unpacked path when it exists
   * (it has the real native binaries), falling back to the asar path
   * (which works for pure-JS modules via Electron's fs patching).
   */
  private resolveModuleDir(moduleName: string): string | null {
    try {
      const pkgJson = require.resolve(moduleName + '/package.json');
      let dir = path.dirname(pkgJson);

      // In packaged builds, check if an unpacked version exists (native modules)
      if (dir.includes('app.asar' + path.sep)) {
        const unpackedDir = dir.replace(/app\.asar([\/\\])/, 'app.asar.unpacked$1');
        try {
          fs.accessSync(path.join(unpackedDir, 'package.json'));
          return unpackedDir;
        } catch {
          // No unpacked version — use asar path (Electron fs can read it for copying)
          return dir;
        }
      }

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
