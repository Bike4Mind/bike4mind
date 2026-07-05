/**
 * Sandbox Orchestrator - decision engine that coordinates sandbox execution
 * with the permission system.
 *
 * Responsibilities:
 * - Manage sandbox mode state (disabled / auto-allow / permissions)
 * - Determine whether a command should be sandboxed, run unsandboxed, or blocked
 * - Coordinate with the runtime adapter for command wrapping
 * - Provide status information for the /sandbox command
 */
import type {
  SandboxConfig,
  SandboxDecision,
  SandboxMode,
  SandboxStats,
  SandboxStatus,
  SandboxViolation,
} from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import type { SandboxRuntime } from './runtime/SandboxRuntimeAdapter.js';
import type { ProxyManager } from './proxy/ProxyManager.js';
import type { ViolationLogStore } from './logging/ViolationLogStore.js';

export class SandboxOrchestrator {
  private config: SandboxConfig;
  private runtime: SandboxRuntime | null;
  private proxyManager: ProxyManager | null;
  private stats: SandboxStats = { sandboxed: 0, unsandboxed: 0, blocked: 0, violations: 0 };
  private violationStore: ViolationLogStore | null = null;

  constructor(config?: SandboxConfig, runtime?: SandboxRuntime | null, proxyManager?: ProxyManager | null) {
    this.config = config ?? DEFAULT_SANDBOX_CONFIG;
    this.runtime = runtime ?? null;
    this.proxyManager = proxyManager ?? null;
  }

  /**
   * Determine whether a command should be sandboxed.
   *
   * Decision logic:
   * 1. If sandbox is disabled -> unsandboxed (no permission change)
   * 2. If command matches an excluded command -> unsandboxed (requires permission)
   * 3. If runtime is not available -> unsandboxed with warning
   * 4. Otherwise -> sandbox the command
   */
  shouldSandbox(command: string, cwd: string): SandboxDecision {
    // 1. Sandbox disabled
    if (!this.config.enabled || this.config.mode === 'disabled') {
      return { type: 'unsandboxed', requiresPermission: true };
    }

    // 2. Check excluded commands
    const baseCommand = this.getBaseCommand(command);
    if (this.isExcludedCommand(baseCommand)) {
      if (!this.config.allowUnsandboxedCommands) {
        return {
          type: 'blocked',
          reason: `Command '${baseCommand}' is excluded from sandboxing and unsandboxed commands are not allowed`,
        };
      }
      return {
        type: 'unsandboxed',
        requiresPermission: true,
        reason: `Command '${baseCommand}' is excluded from sandboxing`,
      };
    }

    // 3. Runtime not available
    if (!this.runtime) {
      return {
        type: 'unsandboxed',
        requiresPermission: true,
        reason: 'Sandbox runtime not available on this platform',
      };
    }

    // 4. Sandbox the command
    const proxyEnv = this.proxyManager?.getProxyEnv() ?? {};
    const wrappedCommand = this.runtime.wrapCommand({
      command,
      cwd,
      filesystemConfig: this.config.filesystem,
      env: proxyEnv,
      ...(this.runtime.platform === 'linux' &&
        this.config.platform.linux.seccompProfile && {
          seccompProfile: this.config.platform.linux.seccompProfile,
        }),
    });

    return { type: 'sandbox', wrappedCommand };
  }

  /** Get the current sandbox mode */
  getMode(): SandboxMode {
    return this.config.mode;
  }

  /** Set the sandbox mode (does not persist - caller must save config) */
  setMode(mode: SandboxMode): void {
    this.config.mode = mode;
    this.config.enabled = mode !== 'disabled';
  }

  /** Check if sandbox is enabled and runtime is available */
  isAvailable(): boolean {
    return this.runtime !== null && this.runtime.isAvailable();
  }

  /** Check if sandbox is currently active (enabled + available) */
  isActive(): boolean {
    return this.config.enabled && this.config.mode !== 'disabled' && this.isAvailable();
  }

  /** Get the current sandbox configuration */
  getConfig(): SandboxConfig {
    return this.config;
  }

  /** Update config (does not persist - caller must save) */
  updateConfig(config: SandboxConfig): void {
    this.config = config;
  }

  /** Get the ProxyManager instance (if any) */
  getProxyManager(): ProxyManager | null {
    return this.proxyManager;
  }

  /** Start the network proxy (if configured) */
  async startProxy(): Promise<void> {
    await this.proxyManager?.start();
  }

  /** Stop the network proxy */
  async stopProxy(): Promise<void> {
    await this.proxyManager?.stop();
  }

  /** Get full status information for display */
  getStatus(): SandboxStatus {
    return {
      mode: this.config.mode,
      enabled: this.config.enabled,
      platform: this.runtime?.platform ?? null,
      runtimeAvailable: this.runtime?.isAvailable() ?? false,
      runtimeName: this.runtime?.name ?? null,
      proxyRunning: this.proxyManager?.isRunning() ?? false,
      proxyPort: this.proxyManager?.getPort() ?? null,
      config: this.config,
      stats: { ...this.stats },
    };
  }

  // --- Stats tracking ---

  recordSandboxed(): void {
    this.stats.sandboxed++;
  }

  recordUnsandboxed(): void {
    this.stats.unsandboxed++;
  }

  recordBlocked(): void {
    this.stats.blocked++;
  }

  recordViolations(count = 1): void {
    this.stats.violations += count;
  }

  getStats(): SandboxStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { sandboxed: 0, unsandboxed: 0, blocked: 0, violations: 0 };
  }

  // --- Violation store ---

  setViolationStore(store: ViolationLogStore): void {
    this.violationStore = store;
  }

  getViolationStore(): ViolationLogStore | null {
    return this.violationStore;
  }

  /** Record a violation to store and increment stats */
  async recordViolation(violation: SandboxViolation): Promise<void> {
    this.stats.violations++;
    await this.violationStore?.record(violation).catch(() => {});
  }

  /**
   * Extract the base command name from a full command string.
   * e.g., "docker compose up -d" -> "docker"
   */
  private getBaseCommand(command: string): string {
    const trimmed = command.trim();
    // Handle env var prefixes like "FOO=bar command"
    const withoutEnv = trimmed.replace(/^(\w+=\S+\s+)*/, '');
    const parts = withoutEnv.split(/\s+/);
    const first = parts[0] || '';
    // Handle paths like /usr/bin/docker -> docker
    return first.split('/').pop() || first;
  }

  /** Check if a command is in the excluded list */
  private isExcludedCommand(baseCommand: string): boolean {
    return this.config.excludedCommands.some(excluded => baseCommand === excluded);
  }
}
