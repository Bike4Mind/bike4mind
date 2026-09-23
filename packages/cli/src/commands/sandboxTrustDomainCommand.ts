/**
 * Handler for the `/sandbox:trust-domain <domain> [...]` slash command.
 *
 * Extracted from the index.tsx command switch so the config/proxy lockstep is
 * unit-testable: grants must route through SandboxOrchestrator.addAllowedDomain
 * (which updates BOTH the persisted config and the live proxy) and then persist
 * getConfig(). Reverting to the proxy-only path would drop the grant on the next
 * /sandbox:network save - a regression this handler's test pins at the seam.
 * Returns the lines to print; the caller only console.logs them.
 */
import type { SandboxConfig } from '../sandbox/types.js';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';

export interface SandboxTrustDomainDeps {
  orchestrator: SandboxOrchestrator | null | undefined;
  configStore: { saveSandboxConfig: (config: SandboxConfig) => Promise<void> };
}

export async function handleSandboxTrustDomainCommand(
  deps: SandboxTrustDomainDeps,
  domains: string[]
): Promise<string> {
  const { orchestrator, configStore } = deps;
  if (!orchestrator) return 'Sandbox not initialized';
  if (domains.length === 0) return 'Usage: /sandbox:trust-domain <domain> [...]';
  if (!orchestrator.getProxyManager()) return 'Network proxy not initialized';

  const lines: string[] = [];
  for (const domain of domains) {
    orchestrator.addAllowedDomain(domain);
    lines.push(`  Added: ${domain}`);
  }
  // Persist ONLY the sandbox field (no repo-merged config laundering).
  await configStore.saveSandboxConfig(orchestrator.getConfig());
  lines.push(`Trusted ${domains.length} domain(s)`);
  return lines.join('\n');
}
