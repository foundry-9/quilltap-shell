/** Runtime mode: VM (Lima/WSL2), Docker, or embedded (Electron's own Node.js) */
export type RuntimeMode = 'docker' | 'vm' | 'embedded';

/** Phase identifiers for splash screen state machine */
export type SplashPhase =
  | 'choose-directory'
  | 'initializing'
  | 'downloading'
  | 'creating-vm'
  | 'updating-vm'
  | 'starting-vm'
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
  /** Size of the associated VM in bytes, or -1 if no VM exists */
  vmSize: number;
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
  /** Current runtime mode (docker or vm) */
  runtimeMode: RuntimeMode;
  /** Whether Docker CLI is available on this system */
  dockerAvailable: boolean;
  /** Whether the embedded server mode is available (always true — uses Electron's Node.js) */
  embeddedAvailable: boolean;
  /** Label for the VM button (e.g. "Lima" on macOS, "WSL2" on Windows) */
  vmLabel: string;
  /** Host platform (darwin, win32, linux) */
  platform: string;
  /** Current server version setting ('latest', 'latest-dev', or a specific tag) */
  serverVersion: string;
  /** Available server versions fetched from GitHub (may be empty if offline) */
  availableVersions: VersionOption[];
  /** Present when the pinned server version is older than the latest in the same channel */
  upgradeAvailable?: { from: string; to: string; toLabel: string };
}

/** Status of the VM (Lima on macOS, WSL2 on Windows) */
export interface VMStatus {
  exists: boolean;
  running: boolean;
  message: string;
}

/** @deprecated Use VMStatus instead */
export type LimaStatus = VMStatus;

/** Progress information during rootfs download */
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

/** Result of a VM command execution (limactl or wsl.exe) */
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}
