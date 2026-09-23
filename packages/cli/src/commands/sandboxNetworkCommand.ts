/**
 * Handler for the `/sandbox:network <on|off>` slash command.
 *
 * Extracted from the index.tsx command switch so the off->on transition (where a
 * stale proxy snapshot could otherwise grant unfiltered egress) is unit-testable.
 * Returns the line to print; the caller only console.logs it. The fail-closed
 * invariant lives in SandboxOrchestrator.setNetworkEnabled - this layer just
 * validates input, gates on availability, persists, and reports.
 */
import type { SandboxConfig, SandboxMode } from '../sandbox/types.js';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';

export interface SandboxNetworkDeps {
  orchestrator: SandboxOrchestrator | null | undefined;
  configStore: { saveSandboxConfig: (config: SandboxConfig) => Promise<void> };
  permissionManager?: { setSandboxState: (mode: SandboxMode, active: boolean) => void } | null;
}

export async function handleSandboxNetworkCommand(deps: SandboxNetworkDeps, arg: string | undefined): Promise<string> {
  const { orchestrator, configStore, permissionManager } = deps;
  if (!orchestrator) return 'Sandbox not initialized';
  if (arg !== 'on' && arg !== 'off') return 'Usage: /sandbox:network <on|off>';
  if (!orchestrator.isAvailable()) return 'Sandbox runtime not available on this platform';

  const enable = arg === 'on';
  const active = await orchestrator.setNetworkEnabled(enable);

  // Fail closed: if enabling did not leave network on (proxy failed to start),
  // report it and persist nothing - the runtime flag is already back to false.
  if (enable && !active) {
    return 'Failed to start the network proxy; network stays disabled (fail-closed). Is the port free?';
  }

  permissionManager?.setSandboxState(orchestrator.getMode(), orchestrator.isActive());
  await configStore.saveSandboxConfig(orchestrator.getConfig());

  if (!enable) return 'Sandbox network disabled (fail-closed)';
  const port = orchestrator.getProxyManager()?.getPort();
  return `Sandbox network enabled (filtered via proxy${port ? ` on port ${port}` : ''})`;
}
