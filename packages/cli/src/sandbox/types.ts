/**
 * Sandbox types and interfaces for OS-level filesystem isolation.
 */

/** Sandbox operating mode */
export type SandboxMode = 'disabled' | 'auto-allow' | 'permissions';

/** Supported sandbox platforms */
export type SandboxPlatform = 'linux' | 'darwin';

/** Filesystem isolation configuration */
export interface FilesystemConfig {
  /** Paths allowed for read access (supports $HOME, $USER expansion) */
  allowedReadPaths: string[];
  /** Paths denied for all access (supports $HOME, $USER expansion) */
  deniedPaths: string[];
  /** Restrict write access to the working directory only */
  writeOnlyToWorkingDir: boolean;
}

/** Network domain filtering configuration */
export interface NetworkConfig {
  enabled: boolean;
  /** Allowed domains: exact match or wildcard (*.github.com) */
  allowedDomains: string[];
}

/** Platform-specific runtime configuration */
export interface PlatformConfig {
  linux: {
    runtime: 'bubblewrap';
    seccompProfile?: string;
  };
  macos: {
    runtime: 'seatbelt';
    profileTemplate: string;
  };
}

/** Full sandbox configuration (stored in config files) */
export interface SandboxConfig {
  enabled: boolean;
  mode: SandboxMode;
  filesystem: FilesystemConfig;
  network: NetworkConfig;
  excludedCommands: string[];
  allowUnsandboxedCommands: boolean;
  platform: PlatformConfig;
}

/** Result of the orchestrator's sandbox decision */
export type SandboxDecision =
  | { type: 'sandbox'; wrappedCommand: WrappedCommand }
  | { type: 'unsandboxed'; requiresPermission: boolean; reason?: string }
  | { type: 'blocked'; reason: string };

/** A command wrapped with sandbox runtime arguments */
export interface WrappedCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** The full command string to pass to bash -c (for CLI-level wrapping) */
  commandString: string;
  /** Temp files that need cleanup after execution */
  cleanupPaths?: string[];
}

/** Record of a sandbox boundary violation */
export interface SandboxViolation {
  type: 'filesystem' | 'network';
  path?: string;
  domain?: string;
  command: string;
  blockedBy: 'sandbox' | 'config' | 'proxy';
  timestamp: Date;
  detail?: string;
}

/** Serialized violation entry for JSONL storage (Date -> epoch ms) */
export interface SandboxViolationEntry {
  type: 'filesystem' | 'network';
  path?: string;
  domain?: string;
  command: string;
  blockedBy: 'sandbox' | 'config' | 'proxy';
  timestamp: number;
  detail?: string;
}

/** In-memory execution stats counters (reset per session) */
export interface SandboxStats {
  sandboxed: number;
  unsandboxed: number;
  blocked: number;
  violations: number;
}

/** Sandbox runtime status information */
export interface SandboxStatus {
  mode: SandboxMode;
  enabled: boolean;
  platform: SandboxPlatform | null;
  runtimeAvailable: boolean;
  runtimeName: string | null;
  proxyRunning: boolean;
  proxyPort: number | null;
  config: SandboxConfig;
  stats?: SandboxStats;
}

/**
 * Deep partial version of SandboxConfig for project/local config overrides.
 * Allows partial filesystem config where individual fields are optional.
 */
export interface PartialSandboxConfig {
  enabled?: boolean;
  mode?: SandboxMode;
  filesystem?: Partial<FilesystemConfig>;
  network?: Partial<NetworkConfig>;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  platform?: PlatformConfig;
}

/** Default sandbox configuration */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  mode: 'disabled',
  filesystem: {
    writeOnlyToWorkingDir: true,
    allowedReadPaths: ['$HOME/.gitconfig', '$HOME/.npmrc', '$HOME/.node_modules'],
    deniedPaths: ['$HOME/.ssh', '$HOME/.aws', '$HOME/.gnupg', '$HOME/.env', '/etc/shadow', '/etc/passwd'],
  },
  network: {
    enabled: false,
    allowedDomains: [
      'registry.npmjs.org',
      '*.npmjs.org',
      'pypi.org',
      '*.pypi.org',
      'files.pythonhosted.org',
      'crates.io',
      '*.crates.io',
      'rubygems.org',
      'github.com',
      '*.github.com',
      'gitlab.com',
      '*.gitlab.com',
      'bitbucket.org',
      '*.bitbucket.org',
      '*.githubusercontent.com',
      '*.cloudflare.com',
    ],
  },
  excludedCommands: ['docker', 'watchman', 'podman'],
  allowUnsandboxedCommands: true,
  platform: {
    linux: {
      runtime: 'bubblewrap',
    },
    macos: {
      runtime: 'seatbelt',
      profileTemplate: 'default',
    },
  },
};
