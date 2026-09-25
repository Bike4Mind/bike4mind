/**
 * Handler for the `/sandbox:network <on|off>` slash command.
 *
 * Extracted from the index.tsx command switch so the off->on transition (where a
 * stale proxy snapshot could otherwise grant unfiltered egress) is unit-testable.
 * Returns the line to print; the caller only console.logs it. The fail-closed
 * invariant lives in SandboxOrchestrator.setNetworkEnabled - this layer just
 * validates input, gates the ENABLE path on availability, persists, and reports.
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

  const enable = arg === 'on';
  // Only ENABLING needs a runtime - turning egress OFF is the fail-closed
  // direction and must always succeed, even on a platform with no sandbox runtime.
  if (enable && !orchestrator.isAvailable()) return 'Sandbox runtime not available on this platform';

  const active = await orchestrator.setNetworkEnabled(enable);

  // Fail closed: if enabling did not leave network on (proxy failed to start),
  // setNetworkEnabled has already reset the runtime flag to false. Persist that
  // reset (same policy as the other paths) so disk and memory agree, then report.
  if (enable && !active) {
    permissionManager?.setSandboxState(orchestrator.getMode(), orchestrator.isActive());
    await configStore.saveSandboxConfig(orchestrator.getConfig());
    return 'Failed to start the network proxy; network stays disabled (fail-closed).';
  }

  permissionManager?.setSandboxState(orchestrator.getMode(), orchestrator.isActive());
  await configStore.saveSandboxConfig(orchestrator.getConfig());

  if (!enable) return 'Sandbox network disabled (fail-closed)';
  const port = orchestrator.getProxyManager()?.getPort();
  // Egress is on at the OS layer; only HTTP(S)_PROXY-aware clients are filtered
  // through the proxy (raw sockets bypass it), so do not overstate the guarantee.
  return `Sandbox network egress enabled${port ? ` (proxy-aware clients filtered on port ${port})` : ''}`;
}
