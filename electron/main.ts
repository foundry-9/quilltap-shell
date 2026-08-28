import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, session, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HOST_PORT,
  SPLASH_WIDTH,
  SPLASH_HEIGHT,
  MAIN_WIDTH,
  MAIN_HEIGHT,
  DEFAULT_DATA_DIR,
  APP_VERSION,
  DOCKER_IMAGE,
} from './constants';
import { DockerManager } from './docker-manager';
import { EmbeddedManager } from './embedded-manager';
import { StandaloneDownloadManager } from './standalone-download-manager';
import { HealthChecker } from './health-checker';
import { SplashUpdate, DirectoryInfo, DirectorySizeInfo, RuntimeMode, WindowBounds, VersionOption } from './types';
import { AppSettings, loadSettings, saveSettings, saveWindowBounds, getWindowBounds, defaultNameForPath } from './settings';
import { getSizesForDir } from './disk-utils';
import { runCrashGuard, markStartupSuccess, isInSafeMode } from './crash-guard';
import { initStartupLog, logStartup, closeStartupLog } from './startup-log';
import { WorkspaceWatcher } from './workspace-watcher';
import { ShellUpdater } from './shell-updater';
import * as spellcheck from './spellcheck-manager';
import { compareVersions } from './version-compare';

app.name = 'Quilltap';

const isDev = !!process.env.ELECTRON_DEV;

/** Detect the host OS timezone to pass through to the backend */
const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log('[Main] Detected host timezone:', hostTimezone);

// Run crash guard before app is ready — tracks consecutive crashes and enters
// safe mode after 3 consecutive failures (clears caches, resets settings)
runCrashGuard();

// Prevent macOS NSPersistentUIRestorer from attempting window state restoration,
// which can cause EXC_BREAKPOINT crashes in the Electron Framework
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-session-crashed-bubble');
  try {
    fs.rmSync(
      path.join(os.homedir(), 'Library', 'Saved Application State', 'com.foundry9.quilltap.savedState'),
      { recursive: true, force: true }
    );
  } catch {
    // Non-fatal — directory may not exist
  }
}

// Handle Ubuntu 24.04+ unprivileged user namespace restriction
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

/** Root of the app directory (for static files like electron/splash/) */
const appRoot = app.isPackaged
  ? app.getAppPath()
  : path.join(__dirname, '..');

let splashWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let dockerManager: DockerManager;
let embeddedManager: EmbeddedManager;
let standaloneManager: StandaloneDownloadManager;
let healthChecker: HealthChecker;
let isQuitting = false;
let appSettings: AppSettings;
let dockerAvailable = false;
const embeddedAvailable = true; // Always available — uses Electron's own Node.js
let cachedAvailableVersions: VersionOption[] | null = null;
let workspaceWatcher: WorkspaceWatcher | null = null;
let shellUpdater: ShellUpdater;

/** Whether we're in the auto-start countdown (can be interrupted) */
let autoStartPending = false;

/** When true, onSplashReady() skips auto-start and goes straight to the directory chooser */
let skipAutoStart = false;

/** Send an update to the splash screen */
function sendSplashUpdate(update: SplashUpdate): void {
  logStartup(update.message, update.detail, update.detailLevel || update.phase);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:update', update);
  }
}

/** Send an error to the splash screen */
function sendSplashError(message: string, canRetry: boolean = true): void {
  logStartup(message, canRetry ? 'canRetry=true' : 'canRetry=false', 'ERROR');
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:error', {
      phase: 'error' as const,
      message,
      canRetry,
    });
  }
}

/**
 * The origin the main window (and menu navigation, and relative downloads)
 * should point at: the dev server in dev mode, the configured remote server
 * in remote mode, and the locally managed server otherwise.
 */
function serverBaseUrl(): string {
  if (isDev) return 'http://localhost:3000';
  if (appSettings.runtimeMode === 'remote' && appSettings.remoteServerUrl) {
    return appSettings.remoteServerUrl;
  }
  return `http://localhost:${HOST_PORT}`;
}

/**
 * Normalize a user-entered remote server address into a usable base URL.
 * Accepts bare host:port (http:// is assumed), preserves any path prefix,
 * strips trailing slashes. Returns null if the address is unusable.
 */
function normalizeRemoteUrl(raw: string): string | null {
  let candidate = (raw || '').trim();
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'http://' + candidate;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Check if the user's pinned server version has a newer release available.
 * - Stable users only see newer stable releases.
 * - Dev users see the newest version across both channels (a newer stable
 *   release is the natural upgrade path out of a dev build).
 * Returns upgrade info or undefined.
 */
function checkForUpgrade(
  serverVersion: string,
  versions: VersionOption[],
  declinedVersion: string,
): DirectoryInfo['upgradeAvailable'] {
  // Only applies to specific pinned versions, not 'latest' / 'latest-dev'
  if (!serverVersion || serverVersion === 'latest' || serverVersion === 'latest-dev') {
    return undefined;
  }

  // Determine if the current pinned version is a prerelease
  const currentInList = versions.find((v) => v.tag === serverVersion);
  const isCurrentDev = currentInList
    ? currentInList.prerelease
    : /[-]/.test(serverVersion.replace(/^v/, '').replace(/^\d+\.\d+\.\d+/, ''));

  // Find the best upgrade candidate:
  // - Stable users: latest stable only
  // - Dev users: whichever is newest across stable and dev
  let latest: VersionOption | undefined;
  if (isCurrentDev) {
    // Offer the single newest version regardless of channel
    latest = versions.find((v) => compareVersions(v.tag, serverVersion) > 0);
  } else {
    // Stable users only see newer stable releases
    latest = versions.find((v) => !v.prerelease && compareVersions(v.tag, serverVersion) > 0);
  }

  if (!latest) return undefined;

  // Has the user already declined this specific version?
  if (declinedVersion === latest.tag) return undefined;

  return { from: serverVersion, to: latest.tag, toLabel: latest.label };
}

/** Send directory info to splash screen (two-phase: immediate with empty sizes, then async with real sizes) */
function sendDirectoryInfo(): void {
  if (!splashWindow || splashWindow.isDestroyed()) return;

  // Read minServerVersion from each instance's dbkey (fast synchronous I/O)
  const minServerVersions = readMinServerVersions();

  const buildCommon = (versions?: VersionOption[]) => ({
    dirs: appSettings.knownDataDirs,
    lastUsed: appSettings.lastDataDir,
    autoStart: appSettings.autoStart,
    runtimeMode: appSettings.runtimeMode,
    dockerAvailable,
    embeddedAvailable,
    platform: process.platform,
    serverVersion: appSettings.serverVersion || 'latest',
    availableVersions: versions || cachedAvailableVersions || [],
    showPrerelease: appSettings.showPrerelease,
    remoteServerUrl: appSettings.remoteServerUrl,
    minServerVersions,
    upgradeAvailable: checkForUpgrade(
      appSettings.serverVersion,
      versions || cachedAvailableVersions || [],
      appSettings.declinedServerVersion,
    ),
  });

  // Phase 1: Send immediately with empty sizes so UI renders fast
  const info: DirectoryInfo = { ...buildCommon(), sizes: {} };
  splashWindow.webContents.send('splash:directories', info);

  // Phase 2: Calculate sizes async in background, send update when done
  calculateDirectorySizes().then((sizes) => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      const updated: DirectoryInfo = { ...buildCommon(), sizes };
      splashWindow.webContents.send('splash:directories', updated);
    }
  });

  // Phase 3: Fetch available versions if not yet cached
  if (!cachedAvailableVersions) {
    standaloneManager.getAvailableVersions('3.2.0', appSettings.runtimeMode).then((versions) => {
      cachedAvailableVersions = versions;
      if (splashWindow && !splashWindow.isDestroyed()) {
        const updated: DirectoryInfo = { ...buildCommon(versions), sizes: {}, availableVersions: versions };
        splashWindow.webContents.send('splash:directories', updated);
      }
    }).catch((err) => {
      console.warn('[Main] Could not fetch available versions:', err);
    });
  }
}

/** Read minServerVersion from each instance's data/quilltap.dbkey file */
function readMinServerVersions(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dir of appSettings.knownDataDirs) {
    const dbkeyPath = path.join(dir.path, 'data', 'quilltap.dbkey');
    try {
      if (fs.existsSync(dbkeyPath)) {
        const raw = fs.readFileSync(dbkeyPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.minServerVersion === 'string' && parsed.minServerVersion) {
          result[dir.path] = parsed.minServerVersion;
        }
      }
    } catch (err) {
      console.warn('[Main] Error reading dbkey for', dir.path, '(non-fatal):', err);
    }
  }
  return result;
}

/** Calculate disk sizes for all known data directories */
async function calculateDirectorySizes(): Promise<Record<string, DirectorySizeInfo>> {
  const sizes: Record<string, DirectorySizeInfo> = {};
  for (const dir of appSettings.knownDataDirs) {
    try {
      sizes[dir.path] = getSizesForDir(dir.path);
    } catch (err) {
      console.warn('[Main] Error calculating size for', dir.path, err);
      sizes[dir.path] = { dataSize: -1 };
    }
  }
  return sizes;
}

/** Build a minimal application menu for the splash screen phase (macOS shows default Help otherwise) */
function buildSplashMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : [{
          label: 'File',
          submenu: [
            { role: 'quit' as const },
          ],
        }]),
    {
      label: 'Help',
      submenu: [
        ...(shellUpdater
          ? [{
              label: 'Check for Updates…',
              click: () => { shellUpdater.checkForUpdatesManual(splashWindow); },
            }]
          : []),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/** Create the splash window */
function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    resizable: false,
    transparent: false,
    center: true,
    show: false,
    backgroundColor: '#0f1729',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(appRoot, 'electron', 'splash', 'splash.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/** Stop the currently running backend (Docker container or embedded server) */
async function stopCurrentBackend(): Promise<void> {
  if (appSettings.runtimeMode === 'docker') {
    console.log('[Main] Stopping Docker container...');
    try {
      await dockerManager.stopContainer();
    } catch (err) {
      console.warn('[Main] Error stopping Docker container (non-fatal):', err);
    }
  } else if (appSettings.runtimeMode === 'embedded') {
    console.log('[Main] Stopping embedded server...');
    try {
      await embeddedManager.stopServer();
    } catch (err) {
      console.warn('[Main] Error stopping embedded server (non-fatal):', err);
    }
  }
  // Remote mode: the server is somebody else's responsibility — nothing to stop
}

/**
 * Restart the backend server. Closes the main window, stops the current
 * backend, recreates the splash, and relaunches with the same data directory.
 */
async function restartServer(): Promise<void> {
  console.log('[Main] Restarting server...');

  // Create splash BEFORE closing main window to avoid triggering window-all-closed quit
  splashWindow = createSplashWindow();
  buildSplashMenu();

  // Now safe to close main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
    mainWindow = null;
  }
  splashWindow.webContents.on('did-finish-load', async () => {
    sendSplashUpdate({
      phase: 'initializing',
      message: 'Restarting server...',
    });

    await stopCurrentBackend();
    routeStartup(appSettings.lastDataDir);
  });
}

/**
 * Switch to a different data directory. Closes the main window, stops the
 * current backend, and shows the directory chooser on the splash screen.
 */
async function changeSite(): Promise<void> {
  console.log('[Main] Changing site...');

  // Set flag so onSplashReady goes to directory chooser instead of auto-start
  skipAutoStart = true;

  // Create splash BEFORE closing main window to avoid triggering window-all-closed quit
  splashWindow = createSplashWindow();
  buildSplashMenu();

  // Now safe to close main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
    mainWindow = null;
  }
  splashWindow.webContents.on('did-finish-load', async () => {
    sendSplashUpdate({
      phase: 'initializing',
      message: 'Stopping server...',
    });

    await stopCurrentBackend();
    onSplashReady();
  });
}

/** Build the application menu with Navigate items */
function buildAppMenu(win: BrowserWindow): void {
  const appOrigin = serverBaseUrl();

  const navigateItems: { label: string; path: string; accelerator?: string }[] = [
    { label: 'Home', path: '/', accelerator: 'CmdOrCtrl+Shift+H' },
    { label: 'Projects', path: '/prospero', accelerator: 'CmdOrCtrl+Shift+P' },
    { label: 'Files', path: '/files', accelerator: 'CmdOrCtrl+Shift+F' },
    { label: 'Characters', path: '/aurora', accelerator: 'CmdOrCtrl+Shift+C' },
    { label: 'Chats', path: '/salon', accelerator: 'CmdOrCtrl+Shift+S' },
    { label: 'Settings', path: '/settings', accelerator: 'CmdOrCtrl+,' },
    { label: 'Profile', path: '/profile' },
    { label: 'About', path: '/about' },
  ];

  const navigateSubmenu = navigateItems.map(({ label, path, accelerator }) => ({
    label,
    accelerator,
    click: () => {
      win.webContents.loadURL(`${appOrigin}${path}`);
    },
  }));

  const serverItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Restart Server',
      click: () => { restartServer(); },
    },
    {
      label: 'Change Site...',
      click: () => { changeSite(); },
    },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            ...serverItems,
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : [{
          label: 'File',
          submenu: [
            ...serverItems,
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Navigate',
      submenu: navigateSubmenu,
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
            ]
          : [
              { role: 'close' as const },
            ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...(shellUpdater
          ? [{
              label: 'Check for Updates…',
              click: () => { shellUpdater.checkForUpdatesManual(win); },
            }]
          : []),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/** Validate that saved window bounds are still visible on a connected display */
function validateBounds(bounds: WindowBounds): WindowBounds | null {
  const displays = screen.getAllDisplays();
  // Check that at least part of the window is on a visible display
  const x = bounds.x ?? 0;
  const y = bounds.y ?? 0;
  const visible = displays.some((display) => {
    const { x: dx, y: dy, width: dw, height: dh } = display.bounds;
    // Window is "visible" if at least 100px of it overlaps a display
    return (
      x + bounds.width > dx + 100 &&
      x < dx + dw - 100 &&
      y + bounds.height > dy + 100 &&
      y < dy + dh - 100
    );
  });
  if (!visible) {
    console.log('[Main] Saved window bounds are off-screen, using defaults');
    return null;
  }
  return bounds;
}

/** Save the current main window bounds to the active data directory's settings */
function persistWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  // When maximized, preserve the pre-maximized bounds so we restore to the right size
  const normalBounds = win.getNormalBounds();
  const bounds: WindowBounds = {
    ...normalBounds,
    isMaximized,
  };
  if (bounds.width && bounds.height) {
    saveWindowBounds(appSettings, appSettings.lastDataDir, bounds);
  }
}

/** Create the main application window */
function createMainWindow(urlPath?: string): BrowserWindow {
  // Restore saved bounds for this data directory, or fall back to defaults
  const dirBounds = getWindowBounds(appSettings, appSettings.lastDataDir);
  const saved = dirBounds ? validateBounds(dirBounds) : null;

  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width: saved?.width ?? MAIN_WIDTH,
    height: saved?.height ?? MAIN_HEIGHT,
    show: false,
    title: 'Quilltap',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (saved?.x !== undefined && saved?.y !== undefined) {
    winOptions.x = saved.x;
    winOptions.y = saved.y;
  }

  const win = new BrowserWindow(winOptions);

  if (saved?.isMaximized) {
    win.maximize();
  }

  // Right-click context menu — spell suggestions, edit actions, and (in dev) Inspect Element
  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      if (suggestions.length === 0) {
        template.push({ label: 'No suggestions', enabled: false });
      } else {
        for (const suggestion of suggestions) {
          template.push({
            label: suggestion,
            click: () => win.webContents.replaceMisspelling(suggestion),
          });
        }
      }
      template.push({ type: 'separator' });
      template.push({
        label: `Add "${params.misspelledWord}" to dictionary`,
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: 'separator' });
    }

    if (params.isEditable) {
      template.push({ role: 'cut', enabled: params.editFlags.canCut });
      template.push({ role: 'copy', enabled: params.editFlags.canCopy });
      template.push({ role: 'paste', enabled: params.editFlags.canPaste });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll' });
    } else if (params.selectionText) {
      template.push({ role: 'copy' });
    }

    if (isDev) {
      if (template.length > 0) template.push({ type: 'separator' });
      template.push({
        label: 'Inspect Element',
        click: () => win.webContents.inspectElement(params.x, params.y),
      });
    }

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Persist bounds on resize, move, maximize, and unmaximize
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedPersist = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => persistWindowBounds(win), 500);
  };
  win.on('resize', debouncedPersist);
  win.on('move', debouncedPersist);
  win.on('maximize', () => persistWindowBounds(win));
  win.on('unmaximize', () => persistWindowBounds(win));

  const baseUrl = serverBaseUrl();
  const url = urlPath ? `${baseUrl}${urlPath}` : baseUrl;

  // Intercept new-window requests (target="_blank", window.open)
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith(baseUrl)) {
      // Same-origin URLs (images, files) can't be opened externally — block them.
      // The frontend handles these with in-app preview modals when running in Electron.
      console.log('[Main] Blocked same-origin new-window request:', targetUrl);
      return { action: 'deny' };
    }
    // External URLs → open in system browser
    console.log('[Main] Opening external URL in system browser:', targetUrl);
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  // Prevent the main window from navigating away to external URLs
  win.webContents.on('will-navigate', (event, navUrl) => {
    if (!navUrl.startsWith(baseUrl)) {
      event.preventDefault();
      console.log('[Main] Blocked in-window navigation to external URL:', navUrl);
      shell.openExternal(navUrl);
    }
  });

  // Forward renderer console messages to main process for diagnostics
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelNames = ['debug', 'info', 'warn', 'error'];
    const levelName = levelNames[level] || 'log';
    if (level >= 2) {
      // Only log warnings and errors to avoid noise
      console.log(`[Renderer:${levelName}] ${message} (${sourceId}:${line})`);
    }
  });

  // Log resource loading failures
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer] Failed to load: ${validatedURL} — ${errorDescription} (${errorCode})`);
  });

  // Log render process crashes
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] Process gone:', details.reason, details.exitCode);
  });

  win.loadURL(url);
  win.once('ready-to-show', () => {
    win.show();

    // Close splash once main window is visible
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }

    // Check for shell (launcher) updates after a short delay so it doesn't
    // compete with the initial page load or server health checks
    if (shellUpdater) {
      setTimeout(() => shellUpdater.checkForUpdates(win), 5000);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  buildAppMenu(win);

  return win;
}

/**
 * Show the directory chooser on the splash screen.
 * Called on first launch or when user clicks "change directory".
 */
function showDirectoryChooser(): void {
  console.log('[Main] Showing directory chooser');
  sendSplashUpdate({
    phase: 'choose-directory',
    message: 'Choose data directory',
  });
  sendDirectoryInfo();
}

/**
 * Handle the splash screen ready event.
 * Decides whether to auto-start or show the directory chooser.
 */
function onSplashReady(): void {
  if (isDev) {
    // In dev mode, skip directory chooser entirely
    devStartupSequence();
    return;
  }

  // "Change Site" sets this flag to bypass auto-start
  if (skipAutoStart) {
    skipAutoStart = false;
    showDirectoryChooser();
    return;
  }

  const autoStartReady = appSettings.runtimeMode === 'remote'
    ? !!appSettings.remoteServerUrl
    : !!appSettings.lastDataDir;

  if (appSettings.autoStart && autoStartReady) {
    // Auto-start: show a brief loading state with "change" link visible
    autoStartPending = true;
    sendSplashUpdate({
      phase: 'initializing',
      message: 'Starting up...',
    });
    // Send directory info so the "change" link knows the state
    sendDirectoryInfo();

    // Give user time to see and click "change directory" before auto-starting
    setTimeout(() => {
      if (autoStartPending) {
        autoStartPending = false;
        routeStartup(appSettings.lastDataDir);
      }
    }, 5000);
  } else {
    // First launch or auto-start disabled — show directory chooser
    showDirectoryChooser();
  }
}

/**
 * Dev-mode startup sequence: connect to the externally-run dev server
 * on localhost:3000 (no backend is spawned by the shell).
 */
async function devStartupSequence(): Promise<void> {
  autoStartPending = false;

  sendSplashUpdate({
    phase: 'waiting-health',
    message: 'Connecting to dev server...',
  });

  const status = await healthChecker.waitForHealthy(30, 1000, (s) => {
    sendSplashUpdate({
      phase: 'waiting-health',
      message: `Waiting for dev server... (attempt ${s.attempts})`,
      detail: s.error || '',
    });
  });

  if (status.status === 'healthy' || status.status === 'degraded') {
    mainWindow = createMainWindow();
    markStartupSuccess();
    return;
  }

  if (status.status === 'locked') {
    // Server is in locked mode — load the setup/unlock page
    mainWindow = createMainWindow('/setup');
    markStartupSuccess();
    return;
  }

  sendSplashError(
    'Could not connect to dev server at localhost:3000. Is "npm run dev" running?',
    true
  );
}

/**
 * Remote startup sequence. Connects to an already-running Quilltap server
 * at the user-configured URL — nothing to download, create, or spawn.
 * Deliberately leaves any locally-managed backend alone: the remote address
 * may well point at it.
 */
async function remoteStartupSequence(): Promise<void> {
  autoStartPending = false;

  const url = appSettings.remoteServerUrl;
  if (!url) {
    showDirectoryChooser();
    return;
  }

  console.log(`[Main] Connecting to remote server: ${url}`);

  sendSplashUpdate({
    phase: 'waiting-health',
    message: 'Connecting to server...',
    detail: url,
  });

  const remoteChecker = new HealthChecker(`${url}/api/health`);
  const healthStatus = await remoteChecker.waitForHealthy(15, 1000, (s) => {
    sendSplashUpdate({
      phase: 'waiting-health',
      message: `Waiting for server... (attempt ${s.attempts})`,
      detail: s.error || url,
    });
  });

  if (healthStatus.status === 'locked') {
    sendSplashUpdate({ phase: 'ready', message: 'Database locked — passphrase required' });
    mainWindow = createMainWindow('/setup');
    markStartupSuccess();
    return;
  }

  if (healthStatus.status === 'healthy' || healthStatus.status === 'degraded') {
    sendSplashUpdate({
      phase: 'ready',
      message: 'Ready!',
    });
    mainWindow = createMainWindow();
    markStartupSuccess();
    return;
  }

  sendSplashError(
    `Could not reach a Quilltap server at ${url}.\n\n` +
    `Make sure the server is running and the address is correct` +
    (healthStatus.error ? `.\n\nLast error: ${healthStatus.error}` : '.'),
    true,
  );
}

/**
 * Check whether a resolved server version satisfies the instance's minServerVersion
 * requirement (read from data/quilltap.dbkey). Returns true if launch may proceed.
 * Shows an error on the splash screen and returns false if the version is too old.
 */
function checkMinServerVersion(dataDir: string, resolvedVersion: string): boolean {
  const dbkeyPath = path.join(dataDir, 'data', 'quilltap.dbkey');
  try {
    if (!fs.existsSync(dbkeyPath)) return true;
    const raw = fs.readFileSync(dbkeyPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const minVersion = parsed.minServerVersion;
    if (typeof minVersion !== 'string' || !minVersion) return true;

    if (compareVersions(resolvedVersion, minVersion) < 0) {
      sendSplashError(
        `This instance requires server version ${minVersion} or newer, ` +
        `but the selected version is ${resolvedVersion}.\n\n` +
        `Please choose a newer server version and try again.`,
        true,
      );
      return false;
    }
  } catch (err) {
    // If we can't read the dbkey, don't block launch
    console.warn('[Main] Error checking minServerVersion (non-fatal):', err);
  }
  return true;
}

/** Route startup to the correct backend based on runtime mode setting. */
function routeStartup(dataDir: string): void {
  if (isDev) {
    devStartupSequence();
  } else if (appSettings.runtimeMode === 'remote') {
    remoteStartupSequence();
  } else if (appSettings.runtimeMode === 'docker') {
    dockerStartupSequence(dataDir);
  } else {
    embeddedStartupSequence(dataDir);
  }
}

/**
 * Docker startup sequence. Orchestrates:
 * 1. Verify Docker available
 * 2. Stop any running embedded server (port conflict prevention)
 * 3. Pull Docker image if needed
 * 4. Start container with bind mount
 * 5. Health check polling
 * 6. Main window launch
 */
async function dockerStartupSequence(dataDir: string): Promise<void> {
  autoStartPending = false;

  // Initialize startup log (overwrites any previous log)
  initStartupLog(dataDir);

  dockerManager.setDataDir(dataDir);
  console.log(`[Main] Docker startup with data directory: ${dataDir}`);
  console.log(`[Main] Container name: ${dockerManager.getContainerName()}`);

  // Step 1: Verify Docker is available
  sendSplashUpdate({
    phase: 'initializing',
    message: 'Checking Docker...',
  });

  if (!dockerAvailable) {
    const installMsg = process.platform === 'linux'
      ? 'Docker Engine is required. Install it from https://docs.docker.com/engine/install/'
      : 'Docker is not available. Install Docker Desktop and try again.';
    sendSplashError(installMsg, true);
    return;
  }

  // Step 2: Stop any running embedded server to prevent port conflicts
  try {
    await embeddedManager.stopServer();
  } catch (err) {
    console.warn('[Main] Could not stop embedded server (non-fatal):', err);
  }

  // Step 3: Resolve target version from settings (same logic as embedded mode)
  let targetVersion = appSettings.serverVersion || '';
  if (!targetVersion || targetVersion === 'latest' || targetVersion === 'latest-dev') {
    try {
      const channel = targetVersion === 'latest-dev' ? 'dev' : 'release';
      sendSplashUpdate({
        phase: 'initializing',
        message: 'Checking for latest server version...',
      });
      targetVersion = await standaloneManager.getLatestVersion(channel);
      console.log(`[Main] Docker: resolved server version: ${targetVersion}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Main] Could not fetch latest version from GitHub:', msg);
      // Fall back to APP_VERSION if offline
      if (APP_VERSION) {
        console.log(`[Main] Docker: falling back to app version: ${APP_VERSION}`);
        targetVersion = APP_VERSION;
      } else {
        sendSplashError(
          `Could not determine server version for Docker.\n\n` +
          `Check your internet connection and try again.\n\n` +
          `Error: ${msg}`,
          true,
        );
        return;
      }
    }
  }

  // Check minServerVersion requirement before proceeding
  if (!checkMinServerVersion(dataDir, targetVersion)) return;

  dockerManager.setImageVersion(targetVersion);

  // Step 4: Ensure the version-matched Docker image is available
  const versionExists = await dockerManager.imageExistsLocally(targetVersion);
  if (!versionExists) {
    // Try to pull the version-specific tag
    sendSplashUpdate({
      phase: 'pulling-image',
      message: 'Pulling Quilltap image...',
      detail: `${DOCKER_IMAGE}:${targetVersion}`,
    });

    const pullResult = await dockerManager.pullImage(targetVersion, (line) => {
      sendSplashUpdate({
        phase: 'pulling-image',
        message: 'Pulling Quilltap image...',
        detail: line.length > 120 ? line.substring(0, 117) + '...' : line,
      });
    });

    if (!pullResult.success) {
      sendSplashError(
        `Failed to pull Docker image ${DOCKER_IMAGE}:${targetVersion}.\n\n` +
        `This version may not have a Docker image available. Try a different version.\n\n` +
        `Error: ${pullResult.error}`,
        true
      );
      return;
    }
  }

  // Step 4: Start container
  sendSplashUpdate({
    phase: 'starting-container',
    message: 'Starting Quilltap container...',
  });

  const startResult = await dockerManager.startContainer((line) => {
    sendSplashUpdate({
      phase: 'starting-container',
      message: 'Starting Quilltap container...',
      detail: line.length > 120 ? line.substring(0, 117) + '...' : line,
    });
  });

  if (!startResult.success) {
    sendSplashError(`Failed to start Docker container: ${startResult.error}`, true);
    return;
  }

  // Step 5: Wait for health
  sendSplashUpdate({
    phase: 'waiting-health',
    message: 'Waiting for Quilltap to start...',
  });

  const healthStatus = await healthChecker.waitForHealthy(undefined, undefined, (s) => {
    sendSplashUpdate({
      phase: 'waiting-health',
      message: `Waiting for server... (attempt ${s.attempts})`,
      detail: s.error || '',
    });
  });

  if (healthStatus.status === 'locked') {
    sendSplashUpdate({ phase: 'ready', message: 'Database locked — passphrase required' });
    closeStartupLog();
    mainWindow = createMainWindow('/setup');
    markStartupSuccess();
  } else if (healthStatus.status === 'healthy' || healthStatus.status === 'degraded') {
    sendSplashUpdate({
      phase: 'ready',
      message: 'Ready!',
    });

    closeStartupLog();
    mainWindow = createMainWindow();
    markStartupSuccess();
  } else {
    const logs = await dockerManager.getLogs(20);
    sendSplashError(
      `Server did not become healthy after ${healthStatus.attempts} attempts.\n\nRecent logs:\n${logs}`,
      true
    );
    closeStartupLog();
  }
}

/**
 * Embedded server startup sequence. Orchestrates:
 * 1. Stop any running Docker container to prevent port conflicts
 * 2. Spawn server.js via Electron's Node.js runtime
 * 3. Health check polling
 * 4. Main window launch
 */
async function embeddedStartupSequence(dataDir: string): Promise<void> {
  autoStartPending = false;

  // Initialize startup log (overwrites any previous log)
  initStartupLog(dataDir);

  console.log(`[Main] Embedded server startup with data directory: ${dataDir}`);

  // Step 1: Stop any running Docker container to prevent port conflicts
  sendSplashUpdate({
    phase: 'initializing',
    message: 'Preparing to start server...',
  });

  try {
    dockerManager.setDataDir(dataDir);
    await dockerManager.stopContainer();
  } catch (err) {
    console.warn('[Main] Could not stop Docker container (non-fatal):', err);
  }

  // Step 2: Ensure standalone server is downloaded and cached
  sendSplashUpdate({
    phase: 'initializing',
    message: 'Checking for server files...',
  });

  // Determine target version: use settings override, or fetch latest from GitHub
  let targetVersion = appSettings.serverVersion || '';
  if (!targetVersion || targetVersion === 'latest' || targetVersion === 'latest-dev') {
    try {
      const channel = targetVersion === 'latest-dev' ? 'dev' : 'release';
      sendSplashUpdate({
        phase: 'initializing',
        message: 'Checking for latest server version...',
      });
      targetVersion = await standaloneManager.getLatestVersion(channel);
      console.log(`[Main] Resolved server version: ${targetVersion}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Main] Could not fetch latest version from GitHub:', msg);
      // Fall back to cached version if available
      const cached = standaloneManager.getCachedVersion();
      if (cached) {
        console.log(`[Main] Falling back to cached version: ${cached}`);
        targetVersion = cached;
      } else {
        sendSplashError(
          `Could not determine server version.\n\n` +
          `Check your internet connection and try again.\n\n` +
          `Error: ${msg}`,
          true,
        );
        return;
      }
    }
  }

  // Check minServerVersion requirement before proceeding
  if (!checkMinServerVersion(dataDir, targetVersion)) return;

  if (!standaloneManager.isCacheValid(targetVersion)) {
    sendSplashUpdate({
      phase: 'downloading',
      message: 'Downloading Quilltap server...',
      detail: `Version ${targetVersion} — this only happens on first launch or after updates`,
    });

    try {
      await standaloneManager.ensureStandalone(targetVersion, (progress) => {
        sendSplashUpdate({
          phase: 'downloading',
          message: 'Downloading Quilltap server...',
          progress: progress.percent,
          detail: `${progress.speed} — ${progress.percent}%`,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendSplashError(`Server download failed: ${msg}`, true);
      return;
    }
  }

  // Step 2b: Link native modules into standalone directory
  try {
    standaloneManager.linkNativeModules();
  } catch (err) {
    console.warn('[Main] Native module linking warning:', err);
    // Non-fatal — server may still work without some native modules
  }

  // Step 2c: Reconcile node-pty's spawn-helper. It is a separate build artifact
  // the tarball ships but node-pty's loader can fail to find (or find without
  // its exec bit), causing `posix_spawnp failed` when a PTY is spawned.
  try {
    standaloneManager.reconcileNodePtyHelper();
  } catch (err) {
    console.warn('[Main] node-pty helper reconciliation warning:', err);
    // Non-fatal — only the in-app terminal feature would be affected
  }

  // Step 3: Start the embedded server
  sendSplashUpdate({
    phase: 'starting-server',
    message: 'Starting Quilltap server...',
    detail: 'Using embedded Node.js runtime',
  });

  let startError: string | null = null;
  let serverFatalError: string | null = null;

  embeddedManager.startServer(
    dataDir,
    (line) => {
      console.log('[EmbeddedManager] output:', line);

      // Detect fatal/blocking errors from structured JSON log lines.
      // These indicate the server cannot start and will never become healthy.
      if (line.includes('"level":"error"') && (
        line.includes('Fatal error') ||
        line.includes('Version guard BLOCKED') ||
        line.includes('cannot run migrations') ||
        line.includes('cannot start server')
      )) {
        try {
          const parsed = JSON.parse(line.startsWith('[stderr] ') ? line.slice(9) : line);
          serverFatalError = parsed.message + (parsed.context?.error ? `: ${parsed.context.error}` : '');
        } catch {
          serverFatalError = line;
        }
      }

      sendSplashUpdate({
        phase: 'starting-server',
        message: 'Starting Quilltap server...',
        detail: line.length > 120 ? line.substring(0, 117) + '...' : line,
      });
    },
    (error) => {
      startError = error;
    },
  );

  // Give the process a moment to fail immediately
  await new Promise(resolve => setTimeout(resolve, 2000));

  if (startError) {
    sendSplashError(`Failed to start server: ${startError}`, true);
    return;
  }

  if (!embeddedManager.isRunning()) {
    const exitCode = embeddedManager.getLastExitCode();
    const recentLines = embeddedManager.getRecentOutput(10);
    const details = recentLines.length > 0
      ? recentLines.join('\n')
      : 'No output captured';
    const codeStr = exitCode !== null ? ` (exit code ${exitCode})` : '';
    sendSplashError(
      `Server process exited unexpectedly${codeStr}.\n\n${details}`,
      true,
    );
    return;
  }

  // Check for fatal error detected during the startup wait
  if (serverFatalError) {
    const recentLines = embeddedManager.getRecentOutput(10);
    const details = recentLines.length > 0 ? recentLines.join('\n') : '';
    sendSplashError(
      `Server reported a fatal error during initialization:\n\n${serverFatalError}` +
      (details ? `\n\nRecent output:\n${details}` : ''),
      true,
    );
    embeddedManager.stopServer();
    return;
  }

  // Step 3: Wait for health
  sendSplashUpdate({
    phase: 'waiting-health',
    message: 'Waiting for Quilltap to start...',
  });

  const healthStatus = await healthChecker.waitForHealthy(undefined, undefined, (s) => {
    sendSplashUpdate({
      phase: 'waiting-health',
      message: `Waiting for server... (attempt ${s.attempts})`,
      detail: s.error || '',
    });
  }, () => serverFatalError);

  if (healthStatus.status === 'locked') {
    sendSplashUpdate({ phase: 'ready', message: 'Database locked — passphrase required' });
    closeStartupLog();
    mainWindow = createMainWindow('/setup');
    markStartupSuccess();
  } else if (healthStatus.status === 'healthy' || healthStatus.status === 'degraded') {
    sendSplashUpdate({
      phase: 'ready',
      message: 'Ready!',
    });

    closeStartupLog();
    mainWindow = createMainWindow();
    markStartupSuccess();
  } else {
    const errorDetail = serverFatalError
      ? `Server reported a fatal error:\n\n${serverFatalError}`
      : `Server did not become healthy after ${healthStatus.attempts} attempts.`;
    const recentLines = embeddedManager.getRecentOutput(15);
    const recentText = recentLines.length > 0
      ? `\n\nRecent server output:\n${recentLines.join('\n')}`
      : '\n\nCheck the application logs for details.';
    sendSplashError(errorDetail + recentText, true);
    closeStartupLog();
    embeddedManager.stopServer();
  }
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  appSettings = loadSettings();

  // If crash guard triggered safe mode, ensure autoStart is off so user gets
  // the directory chooser and can pick a different (working) data directory
  if (isInSafeMode()) {
    console.log('[Main] Safe mode active — disabling autoStart');
    appSettings.autoStart = false;
    saveSettings(appSettings);
  }

  dockerManager = new DockerManager();
  embeddedManager = new EmbeddedManager();
  standaloneManager = new StandaloneDownloadManager();
  healthChecker = isDev
    ? new HealthChecker('http://localhost:3000/api/health')
    : new HealthChecker();

  // Initialize shell auto-updater (skip in dev mode)
  if (!isDev) {
    shellUpdater = new ShellUpdater(appSettings);
    shellUpdater.onBeforeQuitAndInstall(() => stopCurrentBackend());
  }

  // Check Docker availability asynchronously (non-blocking)
  // Embedded mode is always available — uses Electron's own Node.js
  dockerAvailable = await dockerManager.isDockerAvailable();
  console.log('[Main] Docker available:', dockerAvailable);

  // Handle file downloads (backups, exports, etc.) — prompt user with a save dialog
  session.defaultSession.on('will-download', (_event, item) => {
    const suggestedName = item.getFilename();
    const parentWindow = mainWindow || splashWindow || undefined;

    const savePath = dialog.showSaveDialogSync(parentWindow as BrowserWindow, {
      defaultPath: suggestedName,
      filters: [
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (savePath) {
      item.setSavePath(savePath);
      console.log(`[Main] Downloading file to: ${savePath}`);
    } else {
      item.cancel();
      console.log('[Main] Download cancelled by user');
    }
  });

  splashWindow = createSplashWindow();

  // Set a minimal app menu so "Check for Updates…" is available during splash
  buildSplashMenu();

  // Check for shell updates shortly after the splash appears, so users who
  // linger on the directory chooser still get prompted about new versions
  if (shellUpdater) {
    splashWindow.once('ready-to-show', () => {
      setTimeout(() => shellUpdater.checkForUpdates(splashWindow), 3000);
    });
  }

  // Wait for splash to load before starting sequence
  splashWindow.webContents.on('did-finish-load', () => {
    onSplashReady();
  });
});

// --- IPC handlers for directory chooser ---

/** Return current directory list and settings */
ipcMain.handle('splash:get-directories', (): DirectoryInfo => {
  return {
    dirs: appSettings.knownDataDirs,
    lastUsed: appSettings.lastDataDir,
    autoStart: appSettings.autoStart,
    sizes: {},
    runtimeMode: appSettings.runtimeMode,
    dockerAvailable,
    embeddedAvailable,
    platform: process.platform,
    serverVersion: appSettings.serverVersion || 'latest',
    availableVersions: cachedAvailableVersions || [],
    showPrerelease: appSettings.showPrerelease,
    remoteServerUrl: appSettings.remoteServerUrl,
    minServerVersions: readMinServerVersions(),
  };
});

/** Open native folder picker */
ipcMain.handle('splash:select-directory', async (): Promise<string> => {
  if (!splashWindow) return '';

  const result = await dialog.showOpenDialog(splashWindow, {
    title: 'Choose Quilltap Data Directory',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Select',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return '';
  }

  const selectedPath = result.filePaths[0];
  console.log('[Main] User selected directory:', selectedPath);

  // Add to known dirs if not already present
  if (!appSettings.knownDataDirs.some(d => d.path === selectedPath)) {
    appSettings.knownDataDirs.push({ path: selectedPath, name: defaultNameForPath(selectedPath) });
    saveSettings(appSettings);
  }

  // Send updated directory list to splash
  sendDirectoryInfo();

  return selectedPath;
});

/** Set the runtime mode (docker, embedded, or remote) */
ipcMain.on('splash:set-runtime-mode', (_event, mode: string) => {
  const runtimeMode: RuntimeMode = mode === 'docker' ? 'docker'
    : mode === 'remote' ? 'remote' : 'embedded';
  console.log('[Main] Runtime mode set to:', runtimeMode);
  appSettings.runtimeMode = runtimeMode;
  saveSettings(appSettings);

  // Invalidate cached versions — each mode filters by different assets
  cachedAvailableVersions = null;
  sendDirectoryInfo();
});

/** Set the server version (applies to all runtime modes) */
ipcMain.on('splash:set-server-version', (_event, version: string) => {
  console.log('[Main] Server version set to:', version);
  appSettings.serverVersion = version;
  saveSettings(appSettings);
});

/** Toggle pre-release version visibility */
ipcMain.on('splash:set-show-prerelease', (_event, enabled: boolean) => {
  console.log('[Main] Show prerelease set to:', enabled);
  appSettings.showPrerelease = enabled;
  saveSettings(appSettings);
});

/** Accept the upgrade prompt: switch to the offered version */
ipcMain.on('splash:accept-upgrade', (_event, version: string) => {
  console.log('[Main] User accepted upgrade to:', version);
  appSettings.serverVersion = version;
  appSettings.declinedServerVersion = '';
  saveSettings(appSettings);
  sendDirectoryInfo();
});

/** Decline the upgrade prompt: remember the declined version so we don't ask again */
ipcMain.on('splash:decline-upgrade', (_event, version: string) => {
  console.log('[Main] User declined upgrade to:', version);
  appSettings.declinedServerVersion = version;
  saveSettings(appSettings);
});

/** Delete a directory: remove config entry and optionally delete data on disk */
ipcMain.handle('splash:delete-directory', async (_event, dirPath: string, action: string): Promise<boolean> => {
  console.log('[Main] Delete directory:', dirPath, 'action:', action);

  try {
    // Stop and delete any associated Docker container
    try {
      await dockerManager.deleteContainerForDir(dirPath);
    } catch (err) {
      console.warn('[Main] Error cleaning up Docker container for', dirPath, '(non-fatal):', err);
    }

    // If config-and-data, delete the data directory from disk
    if (action === 'config-and-data') {
      console.log('[Main] Deleting data directory from disk:', dirPath);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }

    // Remove from known dirs
    appSettings.knownDataDirs = appSettings.knownDataDirs.filter(d => d.path !== dirPath);

    // Ensure at least one directory remains
    if (appSettings.knownDataDirs.length === 0) {
      appSettings.knownDataDirs = [{ path: DEFAULT_DATA_DIR, name: 'Default' }];
    }

    // If deleted dir was last-used, switch to first available
    if (appSettings.lastDataDir === dirPath) {
      appSettings.lastDataDir = appSettings.knownDataDirs[0].path;
    }

    saveSettings(appSettings);
    sendDirectoryInfo();
    return true;
  } catch (err) {
    console.error('[Main] Error deleting directory:', err);
    return false;
  }
});

/** User chose a directory and clicked Start */
ipcMain.on('splash:start', (_event, dirPath: string) => {
  console.log('[Main] Starting with directory:', dirPath);
  autoStartPending = false;

  // Update settings — move chosen instance to front so the list is MRU-ordered
  appSettings.lastDataDir = dirPath;
  const existingIdx = appSettings.knownDataDirs.findIndex(d => d.path === dirPath);
  if (existingIdx >= 0) {
    const [entry] = appSettings.knownDataDirs.splice(existingIdx, 1);
    appSettings.knownDataDirs.unshift(entry);
  } else {
    appSettings.knownDataDirs.unshift({ path: dirPath, name: defaultNameForPath(dirPath) });
  }
  saveSettings(appSettings);

  routeStartup(dirPath);
});

/** User entered a remote server address and clicked Start */
ipcMain.on('splash:start-remote', (_event, rawUrl: string) => {
  autoStartPending = false;

  const normalized = normalizeRemoteUrl(rawUrl);
  if (!normalized) {
    sendSplashError(
      `That doesn't look like a server address: "${(rawUrl || '').trim()}"\n\n` +
      `Try something like http://192.168.1.20:5050`,
      true,
    );
    return;
  }

  console.log('[Main] Starting with remote server:', normalized);
  appSettings.runtimeMode = 'remote';
  appSettings.remoteServerUrl = normalized;
  saveSettings(appSettings);

  remoteStartupSequence();
});

/** Toggle auto-start preference */
ipcMain.on('splash:set-auto-start', (_event, enabled: boolean) => {
  console.log('[Main] Auto-start set to:', enabled);
  appSettings.autoStart = enabled;
  saveSettings(appSettings);
});

/** Interrupt auto-start to show directory chooser */
ipcMain.on('splash:show-chooser', () => {
  console.log('[Main] User interrupted auto-start — showing directory chooser');
  autoStartPending = false;
  showDirectoryChooser();
});

/** Rename a data directory's display name */
ipcMain.handle('splash:rename-directory', (_event, dirPath: string, newName: string): boolean => {
  const trimmed = newName.trim();
  if (!trimmed) return false;

  const entry = appSettings.knownDataDirs.find(d => d.path === dirPath);
  if (!entry) {
    console.warn('[Main] Rename failed — directory not found:', dirPath);
    return false;
  }

  console.log(`[Main] Renaming directory "${entry.name}" → "${trimmed}" (${dirPath})`);
  entry.name = trimmed;
  saveSettings(appSettings);
  sendDirectoryInfo();
  return true;
});

// Handle retry from splash screen
ipcMain.on('splash:retry', () => {
  routeStartup(appSettings.lastDataDir);
});

// Handle quit from splash screen
ipcMain.on('splash:quit', () => {
  app.quit();
});

// Handle file save from main app window (for blobs already in memory)
ipcMain.handle('app:save-file', async (_event, data: ArrayBuffer, filename: string) => {
  const ext = path.extname(filename).replace('.', '');
  const parentWindow = mainWindow || undefined;
  const result = await dialog.showSaveDialog(parentWindow as BrowserWindow, {
    defaultPath: filename,
    filters: [{ name: ext.toUpperCase() || 'All Files', extensions: [ext || '*'] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, Buffer.from(data));
  console.log(`[Main] Saved file to: ${result.filePath}`);
  return true;
});

// Open a path in the host's file browser
ipcMain.handle('app:open-path', async (_event, dirPath: string) => {
  console.log(`[Main] Opening path in file browser: ${dirPath}`);
  await shell.openPath(dirPath);
});

// Handle URL download from main app window (streams to disk via will-download handler)
ipcMain.handle('app:download-url', async (_event, url: string) => {
  if (!mainWindow) return;
  // Resolve relative URLs against the app server
  const fullUrl = url.startsWith('/') ? `${serverBaseUrl()}${url}` : url;
  console.log(`[Main] Triggering download for: ${fullUrl}`);
  mainWindow.webContents.downloadURL(fullUrl);
});

ipcMain.handle('app:copy-image-to-clipboard', (_event, dataUrl: string) => {
  const image = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(image);
  return true;
});

// --- Spellcheck ---

/** Replace the Quilltap-managed dictionary set with the given words (diff applied internally) */
ipcMain.handle('spellcheck:set-dictionary-words', (_event, words: string[]) => {
  if (!Array.isArray(words)) throw new Error('words must be an array of strings');
  if (!mainWindow) throw new Error('Main window is not open');
  spellcheck.applyDictionaryWords(mainWindow.webContents.session, words);
});

/** Set the spellchecker language list (invalid codes are dropped with a warning) */
ipcMain.handle('spellcheck:set-languages', (_event, codes: string[]) => {
  if (!Array.isArray(codes)) throw new Error('codes must be an array of strings');
  if (!mainWindow) throw new Error('Main window is not open');
  spellcheck.setLanguages(mainWindow.webContents.session, codes);
});

/** Inspect the current spellchecker state */
ipcMain.handle('spellcheck:get-status', () => {
  if (!mainWindow) throw new Error('Main window is not open');
  return spellcheck.getStatus(mainWindow.webContents.session);
});

/** Create a small, frameless window showing a shutdown message */
function createShutdownWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 200,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: '#0f1729',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const backendLabel = appSettings.runtimeMode === 'docker' ? 'container' : 'server';
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f1729; color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100vh; -webkit-app-region: drag; user-select: none;
  }
  .title {
    font-family: Georgia, Cambria, "Times New Roman", serif;
    font-size: 24px; font-weight: 700; color: #f0ebe3; margin-bottom: 16px;
  }
  .message { font-size: 14px; color: #a0a0a0; margin-bottom: 12px; }
  .spinner {
    width: 24px; height: 24px; border: 3px solid #333;
    border-top-color: #d4af37; border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
  <div class="title">Quilltap</div>
  <div class="message">Stopping ${backendLabel}…</div>
  <div class="spinner"></div>
</body></html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
  return win;
}

// Graceful shutdown: stop the Docker container or embedded server before quitting
app.on('before-quit', async (event) => {
  if (isQuitting || isDev) return;

  // Remote mode spawned nothing, so there is nothing to stop
  if (appSettings.runtimeMode === 'remote') {
    if (workspaceWatcher) {
      workspaceWatcher.stop();
      workspaceWatcher = null;
    }
    isQuitting = true;
    return;
  }

  isQuitting = true;
  event.preventDefault();

  // Stop workspace watcher
  if (workspaceWatcher) {
    workspaceWatcher.stop();
    workspaceWatcher = null;
  }

  // Close interactive windows immediately so the user can't keep clicking
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
    mainWindow = null;
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }

  // Show a small shutdown indicator
  const shutdownWindow = createShutdownWindow();

  if (appSettings.runtimeMode === 'docker') {
    console.log('[Main] Stopping Docker container before quit...');
    try {
      await dockerManager.stopContainer();
    } catch (err) {
      console.error('[Main] Error stopping Docker container:', err);
    }
  } else {
    console.log('[Main] Stopping embedded server before quit...');
    try {
      await embeddedManager.stopServer();
    } catch (err) {
      console.error('[Main] Error stopping embedded server:', err);
    }
  }

  if (!shutdownWindow.isDestroyed()) {
    shutdownWindow.close();
  }

  app.quit();
});

// On macOS, quit when all windows closed (not default Electron behavior)
// Guard against the shutdown state where we intentionally close windows before quitting
app.on('window-all-closed', () => {
  if (!isQuitting) {
    app.quit();
  }
});
