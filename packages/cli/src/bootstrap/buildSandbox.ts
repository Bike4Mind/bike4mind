import type { CliConfig } from '../storage';
import type { CheckpointStore } from '../storage/CheckpointStore.js';
import type { PermissionManager } from '../utils';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';

/**
 * Where sandbox status and warnings are written. Interactive startup sends info
 * to stdout and warnings to stderr; headless sends both to stderr because stdout
 * carries its NDJSON protocol. Isolating this is what lets both entrypoints share
 * the ONE wiring path below instead of hand-duplicating (and drifting) it.
 */
export interface SandboxLog {
  info(line: string): void;
  warn(line: string): void;
}

const consoleLog: SandboxLog = {
  info: line => console.log(line),
  warn: line => console.error(line),
};

export interface BuildSandboxInput {
  config: CliConfig;
  sessionId: string;
  permissionManager: PermissionManager;
  /**
   * Created by the shell (it's also needed by generateCliTools and the
   * SubagentOrchestrator). Its `.init()` is awaited here in parallel with the
   * sandbox runtime creation to preserve the original startup parallelism.
   */
  checkpointStore: CheckpointStore;
  /** Status/warning sink. Defaults to console (stdout info, stderr warnings). */
  log?: SandboxLog;
}

export interface BuildSandboxResult {
  sandboxOrchestrator: SandboxOrchestrator;
}

/**
 * Initialize the sandbox orchestrator for OS-level filesystem isolation, wire
 * the network-proxy event handler, attach the violation store, and start the
 * proxy when enabled. The SINGLE sandbox-wiring path for both the interactive
 * shell and headless mode (which passes a stderr sink).
 *
 * Pure bootstrap seam: no React hooks, no Zustand state. Sandbox modules are
 * imported dynamically (as before) so the cost is only paid when init runs.
 */
export async function buildSandbox(input: BuildSandboxInput): Promise<BuildSandboxResult> {
  const { config, sessionId, permissionManager, checkpointStore } = input;
  const log = input.log ?? consoleLog;

  // Import all sandbox modules in parallel, then parallelize runtime init with checkpoint store
  const [
    { createSandboxRuntime },
    { SandboxOrchestrator },
    { DEFAULT_SANDBOX_CONFIG },
    { ProxyManager },
    { ViolationLogStore },
  ] = await Promise.all([
    import('../sandbox/runtime/SandboxRuntimeAdapter.js'),
    import('../sandbox/SandboxOrchestrator.js'),
    import('../sandbox/types.js'),
    import('../sandbox/proxy/ProxyManager.js'),
    import('../sandbox/logging/ViolationLogStore.js'),
  ]);

  const sandboxConfig = config.sandbox ?? DEFAULT_SANDBOX_CONFIG;

  // Sandbox runtime creation and checkpoint initialization are independent
  const [sandboxRuntime] = await Promise.all([createSandboxRuntime(), checkpointStore.init(sessionId).catch(() => {})]);

  const proxyManager = new ProxyManager(sandboxConfig.network);
  const sandboxOrchestrator = new SandboxOrchestrator(sandboxConfig, sandboxRuntime, proxyManager);

  // Register proxy event handler after sandboxOrchestrator is defined
  // to avoid referencing it before initialization
  proxyManager.onEvent(event => {
    if (event.type === 'blocked') {
      log.warn(
        `\n\x1b[41m\x1b[97m BLOCKED \x1b[0m \x1b[31mNetwork proxy denied connection to\x1b[0m \x1b[1m${event.domain}\x1b[0m \x1b[90m(${event.method})\x1b[0m`
      );
      log.warn(`\x1b[90m  Tip: /sandbox:trust-domain ${event.domain}\x1b[0m\n`);

      // Record network violation
      sandboxOrchestrator
        .recordViolation({
          type: 'network',
          domain: event.domain,
          command: `[network] ${event.method} ${event.domain}`,
          blockedBy: 'proxy',
          timestamp: event.timestamp,
          detail: `Blocked ${event.method} to ${event.domain}`,
        })
        .catch(() => {});
    }
  });

  const violationStore = new ViolationLogStore();
  sandboxOrchestrator.setViolationStore(violationStore);

  // Sync sandbox state to permission manager
  permissionManager.setSandboxState(sandboxConfig.mode, sandboxOrchestrator.isActive());

  if (sandboxConfig.enabled && sandboxConfig.mode !== 'disabled') {
    if (sandboxRuntime) {
      log.info(`🔒 Sandbox: ${sandboxConfig.mode} (${sandboxRuntime.name})`);
    } else {
      log.warn('⚠️  Sandbox: enabled but runtime not available on this platform');
    }
    // Start the network proxy through the orchestrator's single lifecycle owner so
    // it fails closed: if the proxy can't start, network is forced back off rather
    // than leaving the runtime flag on with no proxy (which would grant raw egress).
    if (sandboxConfig.network.enabled) {
      const on = await sandboxOrchestrator.setNetworkEnabled(true);
      if (on && proxyManager.isRunning()) {
        log.info(
          `🌐 Network proxy: filtering on port ${proxyManager.getPort()} (${sandboxConfig.network.allowedDomains.length} domains)`
        );
      } else {
        log.warn('⚠️  Sandbox: network filtering requested but the proxy failed to start; egress disabled');
      }
    }
  }

  return { sandboxOrchestrator };
}
