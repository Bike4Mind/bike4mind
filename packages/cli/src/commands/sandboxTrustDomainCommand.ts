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
  // The command args are split on a single space upstream, so a double space yields
  // empty tokens; trim and drop them before they land in the allow-list as ''.
  const clean = domains.map(d => d.trim()).filter(Boolean);
  if (clean.length === 0) return 'Usage: /sandbox:trust-domain <domain> [...]';
  if (!orchestrator.getProxyManager()) return 'Network proxy not initialized';

  const lines: string[] = [];
  for (const domain of clean) {
    orchestrator.addAllowedDomain(domain);
    lines.push(`  Added: ${domain}`);
  }
  // Persist ONLY the sandbox field (no repo-merged config laundering). The live proxy
  // allow-list is already widened by addAllowedDomain; if the persist fails, say so
  // rather than rejecting silently out of the handler (the caller has no try/catch).
  try {
    await configStore.saveSandboxConfig(orchestrator.getConfig());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${lines.join('\n')}\nWarning: failed to persist the trusted domains (${msg}); they apply for this session only.`;
  }
  lines.push(`Trusted ${clean.length} domain(s)`);
  return lines.join('\n');
}
