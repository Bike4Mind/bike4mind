import { describe, it, expect, vi } from 'vitest';
import { handleSandboxTrustDomainCommand, type SandboxTrustDomainDeps } from './sandboxTrustDomainCommand.js';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';

// A fake whose addAllowedDomain mutates the same config getConfig() returns, so a
// test can prove the SAVED config carries the grant (the config/proxy lockstep).
function makeOrchestrator(overrides?: Partial<Record<string, unknown>>): {
  orchestrator: SandboxOrchestrator;
  allowedDomains: string[];
} {
  const allowedDomains: string[] = [];
  const orchestrator = {
    getProxyManager: vi.fn(() => ({ getPort: () => 8888 })),
    addAllowedDomain: vi.fn((domain: string) => {
      if (!allowedDomains.includes(domain)) allowedDomains.push(domain);
    }),
    getConfig: vi.fn(() => ({ network: { enabled: true, allowedDomains } }) as never),
    ...overrides,
  } as unknown as SandboxOrchestrator;
  return { orchestrator, allowedDomains };
}

function makeDeps(orchestrator: SandboxOrchestrator | null): {
  deps: SandboxTrustDomainDeps;
  save: ReturnType<typeof vi.fn>;
} {
  const save = vi.fn(async () => {});
  return { deps: { orchestrator, configStore: { saveSandboxConfig: save } }, save };
}

describe('handleSandboxTrustDomainCommand', () => {
  it('reports when the orchestrator is missing and never saves', async () => {
    const { deps, save } = makeDeps(null);
    expect(await handleSandboxTrustDomainCommand(deps, ['example.com'])).toBe('Sandbox not initialized');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an empty domain list', async () => {
    const { orchestrator } = makeOrchestrator();
    const { deps, save } = makeDeps(orchestrator);
    expect(await handleSandboxTrustDomainCommand(deps, [])).toContain('Usage: /sandbox:trust-domain');
    expect(save).not.toHaveBeenCalled();
  });

  it('reports when the network proxy is not initialized', async () => {
    const { orchestrator } = makeOrchestrator({ getProxyManager: vi.fn(() => undefined) });
    const { deps, save } = makeDeps(orchestrator);
    expect(await handleSandboxTrustDomainCommand(deps, ['example.com'])).toBe('Network proxy not initialized');
    expect(save).not.toHaveBeenCalled();
  });

  it('routes each grant through the orchestrator and persists the config carrying them', async () => {
    const { orchestrator } = makeOrchestrator();
    const { deps, save } = makeDeps(orchestrator);

    const msg = await handleSandboxTrustDomainCommand(deps, ['a.com', 'b.com']);

    expect(orchestrator.addAllowedDomain).toHaveBeenCalledWith('a.com');
    expect(orchestrator.addAllowedDomain).toHaveBeenCalledWith('b.com');
    // The persisted config carries the grants - guards against reverting to a
    // proxy-only path that would drop them on the next /sandbox:network save.
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ allowedDomains: ['a.com', 'b.com'] }) })
    );
    expect(msg).toContain('Added: a.com');
    expect(msg).toContain('Trusted 2 domain(s)');
  });
});
