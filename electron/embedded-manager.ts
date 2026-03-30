import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { HOST_PORT, STANDALONE_CACHE_DIR } from './constants';

/** Append a line to the embedded server log file in the data directory */
function appendServerLog(dataDir: string, line: string): void {
  try {
    const logDir = path.join(dataDir, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'embedded-server.log'), line + '\n');
  } catch {
    // Best-effort logging
  }
}

/**
 * Resolve the path to the Next.js standalone server.js.
 *
 * - Looks in the standalone cache directory first (downloaded from GitHub Releases)
 * - Falls back to a local `.next/standalone/server.js` for development/testing
 * - Respects `QUILLTAP_STANDALONE_DIR` environment variable override
 */
function resolveServerPath(): string {
  // Environment variable override
  const overrideDir = process.env.QUILLTAP_STANDALONE_DIR;
  if (overrideDir) {
    const override = path.join(overrideDir, 'server.js');
    if (fs.existsSync(override)) {
      return override;
    }
  }

  // Downloaded standalone cache
  const cached = path.join(STANDALONE_CACHE_DIR, 'server.js');
  if (fs.existsSync(cached)) {
    return cached;
  }

  // Local / CI testing — use the Next.js standalone output directly
  const projectRoot = path.join(__dirname, '..');
  const local = path.join(projectRoot, '.next', 'standalone', 'server.js');
  if (fs.existsSync(local)) {
    return local;
  }

  throw new Error(
    'Could not find server.js. Run the app to download the standalone tarball, ' +
    'or set QUILLTAP_STANDALONE_DIR to a local standalone directory.',
  );
}

/**
 * Manages the embedded Quilltap server process.
 * Uses Electron's own Node.js runtime (via ELECTRON_RUN_AS_NODE=1) to run
 * the Next.js standalone server.js directly — no system Node.js required.
 */
export class EmbeddedManager {
  private childProcess: ChildProcess | null = null;
  /** Circular buffer of the last N output lines (stdout + stderr) for crash diagnostics */
  private recentOutput: string[] = [];
  private static readonly MAX_RECENT_LINES = 50;
  /** Exit code from the last process exit (null if still running or killed by signal) */
  private lastExitCode: number | null = null;

  constructor() {
    console.log('[EmbeddedManager] Initialized — will use Electron Node.js runtime');
  }

  /** Push a line into the recent output buffer, evicting oldest if full */
  private pushOutput(line: string): void {
    this.recentOutput.push(line);
    if (this.recentOutput.length > EmbeddedManager.MAX_RECENT_LINES) {
      this.recentOutput.shift();
    }
  }

  /** Get the last N lines of output for diagnostics */
  getRecentOutput(count: number = 20): string[] {
    return this.recentOutput.slice(-count);
  }

  /** Get the exit code from the last process run */
  getLastExitCode(): number | null {
    return this.lastExitCode;
  }

  /**
   * Start the Quilltap server using Electron's bundled Node.js.
   * Spawns `process.execPath` with ELECTRON_RUN_AS_NODE=1 to run server.js.
   */
  startServer(
    dataDir: string,
    onOutput?: (line: string) => void,
    onError?: (error: string) => void,
  ): void {
    if (this.childProcess) {
      console.warn('[EmbeddedManager] Server already running — stopping first');
      this.stopServer();
    }

    // Reset diagnostics for this run
    this.recentOutput = [];
    this.lastExitCode = null;

    let serverPath: string;
    try {
      serverPath = resolveServerPath();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[EmbeddedManager]', msg);
      if (onError) onError(msg);
      return;
    }

    console.log(`[EmbeddedManager] Spawning: ${process.execPath} ${serverPath}`);
    console.log(`[EmbeddedManager] Data dir: ${dataDir}`);

    // Detect the host OS timezone to pass through to the server
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // The standalone tarball has node_modules intact. Native modules are
    // symlinked in by StandaloneDownloadManager.linkNativeModules().
    const serverDir = path.dirname(serverPath);
    const modulesDir = path.join(serverDir, 'node_modules');
    console.log(`[EmbeddedManager] Modules dir: ${modulesDir}`);

    this.childProcess = spawn(process.execPath, [serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        // ELECTRON_RUN_AS_NODE makes Electron's binary behave as plain Node.js
        ELECTRON_RUN_AS_NODE: '1',
        // Server configuration
        PORT: String(HOST_PORT),
        HOSTNAME: '0.0.0.0',
        NODE_ENV: 'production',
        QUILLTAP_DATA_DIR: dataDir,
        QUILLTAP_TIMEZONE: hostTimezone,
        NODE_OPTIONS: '--max-old-space-size=2048',
        // Module resolution
        NODE_PATH: modulesDir,
        // Preserve PATH for native module resolution
        PATH: process.env.PATH || '',
        // Preserve HOME for various lookups
        HOME: process.env.HOME || '',
        USERPROFILE: process.env.USERPROFILE || '',
        APPDATA: process.env.APPDATA || '',
        LOCALAPPDATA: process.env.LOCALAPPDATA || '',
        // Preserve temp directory
        TMPDIR: process.env.TMPDIR || '',
        TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || '',
      },
      // Set cwd to the server directory so relative paths in server.js resolve correctly
      cwd: serverDir,
    });

    this.childProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        this.pushOutput(line);
        appendServerLog(dataDir, line);
        if (onOutput) onOutput(line);
      }
    });

    this.childProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        this.pushOutput(`[stderr] ${line}`);
        appendServerLog(dataDir, `[stderr] ${line}`);
        if (onOutput) onOutput(line);
      }
    });

    this.childProcess.on('error', (err) => {
      console.error('[EmbeddedManager] spawn error:', err.message);
      this.pushOutput(`[spawn error] ${err.message}`);
      if (onError) onError(err.message);
      this.childProcess = null;
    });

    this.childProcess.on('close', (code) => {
      this.lastExitCode = code;
      console.log(`[EmbeddedManager] Process exited with code ${code}`);
      if (code !== 0 && code !== null) {
        console.error('[EmbeddedManager] Last output lines:');
        for (const line of this.getRecentOutput(10)) {
          console.error(`  ${line}`);
        }
      }
      this.childProcess = null;
    });
  }

  /**
   * Stop the running embedded server process.
   * Sends SIGTERM with a 10s timeout, then SIGKILL.
   * On Windows, uses taskkill for process tree cleanup.
   */
  async stopServer(): Promise<void> {
    if (!this.childProcess) {
      console.log('[EmbeddedManager] No server process to stop');
      return;
    }

    const proc = this.childProcess;
    const pid = proc.pid;
    console.log(`[EmbeddedManager] Stopping server (PID: ${pid})...`);

    return new Promise<void>((resolve) => {
      let resolved = false;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          this.childProcess = null;
          resolve();
        }
      };

      // Listen for process exit
      proc.once('close', finish);

      if (process.platform === 'win32' && pid) {
        // Windows: use taskkill to kill the process tree
        try {
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
            stdio: 'ignore',
          });
        } catch (err) {
          console.warn('[EmbeddedManager] taskkill error:', err);
        }
      } else {
        // Unix: SIGTERM first
        proc.kill('SIGTERM');
      }

      // Force kill after 10 seconds if still running
      setTimeout(() => {
        if (!resolved && proc.pid) {
          console.warn('[EmbeddedManager] Process did not exit after SIGTERM, sending SIGKILL');
          try {
            proc.kill('SIGKILL');
          } catch {
            // Process may have already exited
          }
        }
        // Resolve regardless after timeout
        setTimeout(finish, 1000);
      }, 10_000);
    });
  }

  /** Check whether the embedded server process is currently running */
  isRunning(): boolean {
    return this.childProcess !== null && !this.childProcess.killed;
  }
}
