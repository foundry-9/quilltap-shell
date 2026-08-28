/** Runtime mode: Docker, embedded (Electron's own Node.js), or remote (an already-running server) */
export type RuntimeMode = 'docker' | 'embedded' | 'remote';

/** Phase identifiers for splash screen state machine */
export type SplashPhase =
  | 'choose-directory'
  | 'initializing'
  | 'downloading'
  | 'pulling-image'
  | 'starting-container'
  | 'starting-server'
  | 'waiting-health'
  | 'ready'
  | 'error';

/** Saved window bounds for restore on next launch */
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

/** A data directory with a human-readable name */
export interface NamedDataDir {
  /** Absolute file path */
  path: string;
  /** Human-readable display name */
  name: string;
  /** Remembered main window bounds for this instance */
  windowBounds?: WindowBounds;
}

/** Disk usage information for a single data directory */
export interface DirectorySizeInfo {
  /** Size of the data directory in bytes, or -1 if unknown/missing */
  dataSize: number;
}

/** Directory information sent to the splash screen */
export interface DirectoryInfo {
  /** All known data directories */
  dirs: NamedDataDir[];
  /** The last-used directory (pre-selected) */
  lastUsed: string;
  /** Whether auto-start is enabled */
  autoStart: boolean;
  /** Disk usage per directory path (may arrive asynchronously) */
  sizes: Record<string, DirectorySizeInfo>;
  /** Minimum server version per directory path, read from data/quilltap.dbkey (empty string if none) */
  minServerVersions: Record<string, string>;
  /** Current runtime mode */
  runtimeMode: RuntimeMode;
  /** Whether Docker CLI is available on this system */
  dockerAvailable: boolean;
  /** Whether the embedded server mode is available (always true — uses Electron's Node.js) */
  embeddedAvailable: boolean;
  /** Host platform (darwin, win32, linux) */
  platform: string;
  /** Current server version setting ('latest', 'latest-dev', or a specific tag) */
  serverVersion: string;
  /** Available server versions fetched from GitHub (may be empty if offline) */
  availableVersions: VersionOption[];
  /** Whether to show pre-release / dev versions in the version selector */
  showPrerelease: boolean;
  /** Saved remote server URL (empty string if never configured) */
  remoteServerUrl: string;
  /** Present when the pinned server version is older than the latest in the same channel */
  upgradeAvailable?: { from: string; to: string; toLabel: string };
}

/** Progress information during server download */
export interface DownloadProgress {
  phase: 'downloading';
  bytesReceived: number;
  totalBytes: number;
  percent: number;
  speed: string;
}

/** A selectable server version option */
export interface VersionOption {
  /** Version tag (e.g. '3.2.5' or '3.3.0-dev.1') */
  tag: string;
  /** Human-readable label (e.g. 'v3.2.5' or 'v3.3.0-dev.1 (pre-release)') */
  label: string;
  /** Whether this is a pre-release / dev build */
  prerelease: boolean;
}

/** Health endpoint polling status */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unreachable' | 'locked';
  attempts: number;
  error?: string;
  /** Present when status is 'locked' — the database key state */
  dbKeyState?: string;
}

/** Log level for color-coding detail text on the splash screen */
export type DetailLevel = 'info' | 'warn' | 'error' | 'debug';

/** Update message sent to splash screen via IPC */
export interface SplashUpdate {
  phase: SplashPhase;
  message: string;
  progress?: number;
  detail?: string;
  /** Log level for color-coding the detail text */
  detailLevel?: DetailLevel;
  canRetry?: boolean;
}

/** Result of a docker CLI command execution */
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}
