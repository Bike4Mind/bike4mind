import { describe, it, expect, vi } from 'vitest';

// A runtime that is "available" so buildSandbox enters the network branch.
vi.mock('../sandbox/runtime/SandboxRuntimeAdapter.js', () => ({
  createSandboxRuntime: async () => ({
    platform: 'linux',
    name: 'mock-runtime',
    isAvailable: () => true,
    wrapCommand: () => ({ executable: 'sh', args: [], env: {}, commandString: '', cleanupPaths: [] }),
  }),
}));

// A ProxyManager whose start() never brings the proxy up (isRunning stays false),
// so setNetworkEnabled must fail closed.
vi.mock('../sandbox/proxy/ProxyManager.js', () => ({
  ProxyManager: class {
    setEnabled = vi.fn();
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    isRunning = () => false;
    getPort = () => null;
    getProxyEnv = () => ({});
    addAllowedDomain = vi.fn();
    getAllowedDomains = () => [];
    onEvent = vi.fn(() => () => {});
  },
}));

import { buildSandbox } from './buildSandbox.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox/types.js';

describe('buildSandbox network fail-closed branch', () => {
  it('warns and forces network off when the proxy will not start', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const config = {
      sandbox: {
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
        mode: 'auto-allow',
        network: { ...DEFAULT_SANDBOX_CONFIG.network, enabled: true },
      },
    } as never;
    const checkpointStore = { init: vi.fn().mockResolvedValue(undefined) } as never;
    const permissionManager = { setSandboxState: vi.fn() } as never;

    const { sandboxOrchestrator } = await buildSandbox({
      config,
      sessionId: 'sess-1',
      permissionManager,
      checkpointStore,
      log: { info, warn },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proxy failed to start'));
    expect(sandboxOrchestrator.getConfig().network.enabled).toBe(false);
    // Nothing was routed to stdout-style info claiming the proxy is filtering.
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Network proxy: filtering'));
  });
});
