import { autoUpdater, UpdateInfo } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';
import { APP_VERSION } from './constants';
import { AppSettings, saveSettings } from './settings';

/**
 * Manages automatic updates for the Quilltap Launcher (the Electron shell itself).
 *
 * Uses electron-updater to check GitHub Releases for newer versions, prompt the
 * user with a native dialog, and — upon acceptance — download, install, and
 * relaunch.  Respects a "declined version" setting so we don't pester users who
 * said "not now" until a *newer* version appears.
 */
export class ShellUpdater {
  private settings: AppSettings;
  private stopBackend: (() => Promise<void>) | null = null;
  private pendingVersion: string | null = null;

  constructor(settings: AppSettings) {
    this.settings = settings;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    // Log everything — useful for debugging update issues
    autoUpdater.logger = {
      info: (msg: unknown) => console.log('[ShellUpdater]', msg),
      warn: (msg: unknown) => console.warn('[ShellUpdater]', msg),
      error: (msg: unknown) => console.error('[ShellUpdater]', msg),
      debug: (msg: unknown) => console.log('[ShellUpdater:debug]', msg),
    };
  }

  /**
   * Register the backend shutdown callback.  Called before quitAndInstall so
   * the running server (embedded, Docker, Lima, WSL2) is stopped gracefully.
   */
  onBeforeQuitAndInstall(fn: () => Promise<void>): void {
    this.stopBackend = fn;
  }

  /**
   * Check GitHub Releases for a newer launcher version.  Shows a native dialog
   * if an update is available and the user hasn't declined this specific version.
   *
   * @param parentWindow  The window to attach the dialog to (may be null during splash)
   */
  async checkForUpdates(parentWindow: BrowserWindow | null): Promise<void> {
    if (!APP_VERSION) {
      console.log('[ShellUpdater] No APP_VERSION — skipping update check');
      return;
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) return;

      const available = result.updateInfo;
      const newVersion = available.version;

      // Already running this version (or newer somehow)
      if (newVersion === APP_VERSION) return;

      // User already declined this specific version
      if (this.settings.declinedShellVersion === newVersion) {
        console.log(`[ShellUpdater] User previously declined v${newVersion} — skipping`);
        return;
      }

      this.pendingVersion = newVersion;
      await this.promptUser(available, parentWindow);
    } catch (err) {
      // Network errors, rate limits, etc. — never fatal
      console.warn('[ShellUpdater] Update check failed (non-fatal):', err);
    }
  }

  private async promptUser(info: UpdateInfo, parentWindow: BrowserWindow | null): Promise<void> {
    const version = info.version;
    const releaseNotes = typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : undefined;

    const message = `A new Quilltap Launcher version is available: v${version}\n\n` +
      `You are currently running v${APP_VERSION}.\n\n` +
      'Would you like to download and install the update? ' +
      'Quilltap will restart automatically once the update is ready.';

    const detail = releaseNotes
      ? `Release notes:\n${releaseNotes}`
      : undefined;

    const dialogOpts: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'Quilltap Launcher Update Available',
      message,
      detail,
      buttons: ['Update and Restart', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
    };

    const win = (parentWindow && !parentWindow.isDestroyed()) ? parentWindow : undefined;
    const { response } = win
      ? await dialog.showMessageBox(win, dialogOpts)
      : await dialog.showMessageBox(dialogOpts);

    if (response === 0) {
      await this.downloadAndInstall(parentWindow);
    } else {
      // Remember declined version
      console.log(`[ShellUpdater] User declined v${version}`);
      this.settings.declinedShellVersion = version;
      saveSettings(this.settings);
    }
  }

  private async downloadAndInstall(parentWindow: BrowserWindow | null): Promise<void> {
    // Show a progress dialog
    const progressWindow = new BrowserWindow({
      width: 400,
      height: 120,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      frame: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const progressHtml = `<!DOCTYPE html>
<html><head><style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; padding: 20px; background: #1a1a2e; color: #e0e0e0;
    display: flex; flex-direction: column; justify-content: center;
    height: calc(100vh - 40px);
  }
  .label { font-size: 13px; margin-bottom: 10px; }
  .bar-bg {
    background: #2a2a4a; border-radius: 6px; height: 8px; overflow: hidden;
  }
  .bar-fill {
    background: linear-gradient(90deg, #c9a84c, #e6c55a);
    height: 100%; width: 0%; transition: width 0.3s ease;
    border-radius: 6px;
  }
  .pct { font-size: 11px; margin-top: 6px; color: #999; }
</style></head><body>
  <div class="label">Downloading Quilltap Launcher update…</div>
  <div class="bar-bg"><div class="bar-fill" id="fill"></div></div>
  <div class="pct" id="pct">0%</div>
</body></html>`;

    progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressHtml)}`);

    autoUpdater.on('download-progress', (progress) => {
      if (!progressWindow.isDestroyed()) {
        const pct = Math.round(progress.percent);
        progressWindow.webContents.executeJavaScript(
          `document.getElementById('fill').style.width='${pct}%';` +
          `document.getElementById('pct').textContent='${pct}%';`
        ).catch(() => {});
      }
    });

    try {
      await autoUpdater.downloadUpdate();

      if (!progressWindow.isDestroyed()) {
        progressWindow.webContents.executeJavaScript(
          `document.getElementById('fill').style.width='100%';` +
          `document.getElementById('pct').textContent='Installing…';` +
          `document.querySelector('.label').textContent='Update downloaded. Restarting…';`
        ).catch(() => {});
      }

      // Graceful backend shutdown before install
      if (this.stopBackend) {
        try {
          await this.stopBackend();
        } catch (err) {
          console.error('[ShellUpdater] Error stopping backend before update:', err);
        }
      }

      // Clear the declined version since the user accepted
      this.settings.declinedShellVersion = '';
      saveSettings(this.settings);

      // quitAndInstall: closes all windows, installs, relaunches
      autoUpdater.quitAndInstall();
    } catch (err) {
      console.error('[ShellUpdater] Download/install failed:', err);
      if (!progressWindow.isDestroyed()) {
        progressWindow.close();
      }

      const win = (parentWindow && !parentWindow.isDestroyed()) ? parentWindow : undefined;
      const opts: Electron.MessageBoxOptions = {
        type: 'error',
        title: 'Update Failed',
        message: 'The Quilltap Launcher update could not be downloaded.',
        detail: String(err),
        buttons: ['OK'],
      };
      if (win) {
        await dialog.showMessageBox(win, opts);
      } else {
        await dialog.showMessageBox(opts);
      }
    }
  }
}
