import { describe, it, expect, vi, beforeEach } from 'vitest';

// A runtime that is "available" so buildSandbox enters the network branch.
vi.mock('../sandbox/runtime/SandboxRuntimeAdapter.js', () => ({
  createSandboxRuntime: async () => ({
    platform: 'linux',
    name: 'mock-runtime',
    isAvailable: () => true,
    wrapCommand: () => ({ executable: 'sh', args: [], env: {}, commandString: '', cleanupPaths: [] }),
  }),
}));

// Whether the mock proxy's start() actually brings it up. Toggled per test so we
// can exercise BOTH the fail-closed branch (start no-ops, isRunning stays false)
// and the happy branch (start succeeds, isRunning true -> "filtering on port N").
let proxyStarts = false;

vi.mock('../sandbox/proxy/ProxyManager.js', () => ({
  ProxyManager: class {
    private running = false;
    setEnabled = vi.fn();
    start = vi.fn(async () => {
      if (proxyStarts) this.running = true;
    });
    stop = vi.fn(async () => {
      this.running = false;
    });
    isRunning = () => this.running;
    getPort = () => (this.running ? 8080 : null);
    getProxyEnv = () => ({});
    addAllowedDomain = vi.fn();
    getAllowedDomains = () => [];
    onEvent = vi.fn(() => () => {});
  },
}));

import { buildSandbox } from './buildSandbox.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox/types.js';

function networkEnabledConfig() {
  return {
    sandbox: {
      ...DEFAULT_SANDBOX_CONFIG,
      enabled: true,
      mode: 'auto-allow',
      network: { ...DEFAULT_SANDBOX_CONFIG.network, enabled: true },
    },
  } as never;
}

async function run(info: (line: string) => void, warn: (line: string) => void) {
  return buildSandbox({
    config: networkEnabledConfig(),
    sessionId: 'sess-1',
    permissionManager: { setSandboxState: vi.fn() } as never,
    checkpointStore: { init: vi.fn().mockResolvedValue(undefined) } as never,
    log: { info, warn },
  });
}

describe('buildSandbox network branch', () => {
  beforeEach(() => {
    proxyStarts = false;
  });

  it('warns and forces network off when the proxy will not start', async () => {
    proxyStarts = false;
    const info = vi.fn();
    const warn = vi.fn();

    const { sandboxOrchestrator } = await run(info, warn);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proxy failed to start'));
    expect(sandboxOrchestrator.getConfig().network.enabled).toBe(false);
    // Nothing was routed to stdout-style info claiming the proxy is filtering.
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Network proxy: filtering'));
  });

  it('reports the filtering port and keeps network on when the proxy starts', async () => {
    proxyStarts = true;
    const info = vi.fn();
    const warn = vi.fn();

    const { sandboxOrchestrator } = await run(info, warn);

    expect(info).toHaveBeenCalledWith(expect.stringContaining('Network proxy: filtering on port 8080'));
    expect(sandboxOrchestrator.getConfig().network.enabled).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('proxy failed to start'));
  });
});
