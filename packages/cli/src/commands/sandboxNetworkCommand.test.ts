import { describe, it, expect, vi } from 'vitest';
import { handleSandboxNetworkCommand, type SandboxNetworkDeps } from './sandboxNetworkCommand.js';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';

function makeOrchestrator(overrides?: Partial<Record<string, unknown>>): SandboxOrchestrator {
  return {
    isAvailable: vi.fn(() => true),
    setNetworkEnabled: vi.fn(async () => true),
    getMode: vi.fn(() => 'auto-allow'),
    isActive: vi.fn(() => true),
    getConfig: vi.fn(() => ({}) as never),
    getProxyManager: vi.fn(() => ({ getPort: () => 8888 })),
    ...overrides,
  } as unknown as SandboxOrchestrator;
}

function makeDeps(orchestrator: SandboxOrchestrator | null): {
  deps: SandboxNetworkDeps;
  save: ReturnType<typeof vi.fn>;
  setSandboxState: ReturnType<typeof vi.fn>;
} {
  const save = vi.fn(async () => {});
  const setSandboxState = vi.fn();
  return {
    deps: { orchestrator, configStore: { saveSandboxConfig: save }, permissionManager: { setSandboxState } },
    save,
    setSandboxState,
  };
}

describe('handleSandboxNetworkCommand', () => {
  it('reports when the orchestrator is missing and never saves', async () => {
    const { deps, save } = makeDeps(null);
    expect(await handleSandboxNetworkCommand(deps, 'on')).toBe('Sandbox not initialized');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an invalid argument', async () => {
    const { deps } = makeDeps(makeOrchestrator());
    expect(await handleSandboxNetworkCommand(deps, 'yes')).toContain('Usage: /sandbox:network <on|off>');
    expect(await handleSandboxNetworkCommand(deps, undefined)).toContain('Usage:');
  });

  it('enabling reports when the runtime is unavailable and never toggles', async () => {
    const orchestrator = makeOrchestrator({ isAvailable: vi.fn(() => false) });
    const { deps, save } = makeDeps(orchestrator);
    expect(await handleSandboxNetworkCommand(deps, 'on')).toBe('Sandbox runtime not available on this platform');
    expect(orchestrator.setNetworkEnabled).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('off always succeeds even with no runtime - the fail-closed direction is never gated', async () => {
    const orchestrator = makeOrchestrator({
      isAvailable: vi.fn(() => false),
      setNetworkEnabled: vi.fn(async () => false),
    });
    const { deps, save } = makeDeps(orchestrator);

    const msg = await handleSandboxNetworkCommand(deps, 'off');

    expect(orchestrator.setNetworkEnabled).toHaveBeenCalledWith(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(msg).toBe('Sandbox network disabled (fail-closed)');
  });

  it('on: enables, persists, syncs permission state, reports the port', async () => {
    const orchestrator = makeOrchestrator();
    const { deps, save, setSandboxState } = makeDeps(orchestrator);

    const msg = await handleSandboxNetworkCommand(deps, 'on');

    expect(orchestrator.setNetworkEnabled).toHaveBeenCalledWith(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(setSandboxState).toHaveBeenCalledTimes(1);
    expect(msg).toBe('Sandbox network egress enabled (proxy-aware clients filtered on port 8888)');
  });

  it('on but proxy fails to start: fails closed and persists the reset (disk matches memory)', async () => {
    const orchestrator = makeOrchestrator({ setNetworkEnabled: vi.fn(async () => false) });
    const { deps, save } = makeDeps(orchestrator);

    const msg = await handleSandboxNetworkCommand(deps, 'on');

    expect(msg).toContain('Failed to start the network proxy');
    expect(msg).toContain('fail-closed');
    // The reset (network.enabled already back to false) is persisted so a later boot
    // does not load a stale `true`.
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('off: disables, persists, and reports fail-closed', async () => {
    const orchestrator = makeOrchestrator({ setNetworkEnabled: vi.fn(async () => false) });
    const { deps, save } = makeDeps(orchestrator);

    const msg = await handleSandboxNetworkCommand(deps, 'off');

    expect(orchestrator.setNetworkEnabled).toHaveBeenCalledWith(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(msg).toBe('Sandbox network disabled (fail-closed)');
  });
});
