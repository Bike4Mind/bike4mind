import { describe, it, expect, vi } from 'vitest';
import { SandboxOrchestrator } from './SandboxOrchestrator.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import type { SandboxConfig, SandboxViolation } from './types.js';
import type { SandboxRuntime, WrapCommandOptions } from './runtime/SandboxRuntimeAdapter.js';
import type { ProxyManager } from './proxy/ProxyManager.js';
import type { ViolationLogStore } from './logging/ViolationLogStore.js';

/** Create a mock SandboxRuntime */
function createMockRuntime(available = true): SandboxRuntime {
  return {
    platform: 'darwin',
    name: 'mock-seatbelt',
    isAvailable: () => available,
    wrapCommand: (options: WrapCommandOptions) => ({
      executable: 'sandbox-exec',
      args: ['-f', '/tmp/profile.sb', 'bash', '-c', options.command],
      env: {},
      commandString: `sandbox-exec -f /tmp/profile.sb bash -c '${options.command}'`,
      cleanupPaths: ['/tmp/profile.sb'],
    }),
  };
}

function enabledConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    ...DEFAULT_SANDBOX_CONFIG,
    enabled: true,
    mode: 'auto-allow',
    ...overrides,
  };
}

/** Create a mock ProxyManager */
function createMockProxyManager(running: boolean, port: number | null): ProxyManager {
  const env =
    running && port ? { HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}` } : {};
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getProxyEnv: () => env,
    addAllowedDomain: vi.fn(),
    getAllowedDomains: () => [],
    isRunning: () => running,
    getPort: () => port,
    onEvent: vi.fn(() => () => {}),
  } as unknown as ProxyManager;
}

describe('SandboxOrchestrator', () => {
  describe('shouldSandbox', () => {
    it('returns unsandboxed when sandbox is disabled', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, createMockRuntime());
      const decision = orchestrator.shouldSandbox('ls -la', '/tmp');
      expect(decision.type).toBe('unsandboxed');
    });

    it('returns unsandboxed when mode is disabled', () => {
      const config = enabledConfig({ mode: 'disabled', enabled: false });
      const orchestrator = new SandboxOrchestrator(config, createMockRuntime());
      const decision = orchestrator.shouldSandbox('ls -la', '/tmp');
      expect(decision.type).toBe('unsandboxed');
    });

    it('returns sandbox decision when enabled and available', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime());
      const decision = orchestrator.shouldSandbox('ls -la', '/tmp');
      expect(decision.type).toBe('sandbox');
      if (decision.type === 'sandbox') {
        expect(decision.wrappedCommand.executable).toBe('sandbox-exec');
        expect(decision.wrappedCommand.commandString).toContain('ls -la');
      }
    });

    it('returns unsandboxed for excluded commands', () => {
      const config = enabledConfig({ excludedCommands: ['docker', 'watchman'] });
      const orchestrator = new SandboxOrchestrator(config, createMockRuntime());

      const decision = orchestrator.shouldSandbox('docker compose up', '/tmp');
      expect(decision.type).toBe('unsandboxed');
      if (decision.type === 'unsandboxed') {
        expect(decision.requiresPermission).toBe(true);
        expect(decision.reason).toContain('docker');
      }
    });

    it('returns unsandboxed when runtime is null', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), null);
      const decision = orchestrator.shouldSandbox('ls -la', '/tmp');
      expect(decision.type).toBe('unsandboxed');
      if (decision.type === 'unsandboxed') {
        expect(decision.reason).toContain('not available');
      }
    });

    it('handles commands with env var prefixes', () => {
      const config = enabledConfig({ excludedCommands: ['docker'] });
      const orchestrator = new SandboxOrchestrator(config, createMockRuntime());
      const decision = orchestrator.shouldSandbox('COMPOSE_PROJECT_NAME=test docker compose up', '/tmp');
      expect(decision.type).toBe('unsandboxed');
    });

    it('handles commands with full paths', () => {
      const config = enabledConfig({ excludedCommands: ['docker'] });
      const orchestrator = new SandboxOrchestrator(config, createMockRuntime());
      const decision = orchestrator.shouldSandbox('/usr/bin/docker ps', '/tmp');
      expect(decision.type).toBe('unsandboxed');
    });

    it('blocks excluded commands when allowUnsandboxedCommands is false', () => {
      const config = enabledConfig({
        excludedCommands: ['docker', 'watchman'],
        allowUnsandboxedCommands: false,
      });
      const orchestrator = new SandboxOrchestrator(config, createMockRuntime());

      const decision = orchestrator.shouldSandbox('docker compose up', '/tmp');
      expect(decision.type).toBe('blocked');
      if (decision.type === 'blocked') {
        expect(decision.reason).toContain('docker');
        expect(decision.reason).toContain('unsandboxed commands are not allowed');
      }
    });

    it('allows excluded commands unsandboxed when allowUnsandboxedCommands is true', () => {
      const config = enabledConfig({
        excludedCommands: ['docker'],
        allowUnsandboxedCommands: true,
      });
      const orchestrator = new SandboxOrchestrator(config, createMockRuntime());

      const decision = orchestrator.shouldSandbox('docker ps', '/tmp');
      expect(decision.type).toBe('unsandboxed');
      if (decision.type === 'unsandboxed') {
        expect(decision.requiresPermission).toBe(true);
      }
    });
  });

  describe('mode management', () => {
    it('returns current mode', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig({ mode: 'permissions' }), createMockRuntime());
      expect(orchestrator.getMode()).toBe('permissions');
    });

    it('sets mode and updates enabled flag', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, createMockRuntime());
      expect(orchestrator.getMode()).toBe('disabled');

      orchestrator.setMode('auto-allow');
      expect(orchestrator.getMode()).toBe('auto-allow');
      expect(orchestrator.getConfig().enabled).toBe(true);

      orchestrator.setMode('disabled');
      expect(orchestrator.getMode()).toBe('disabled');
      expect(orchestrator.getConfig().enabled).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('returns true when runtime is available', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, createMockRuntime(true));
      expect(orchestrator.isAvailable()).toBe(true);
    });

    it('returns false when runtime is null', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, null);
      expect(orchestrator.isAvailable()).toBe(false);
    });

    it('returns false when runtime is not available', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, createMockRuntime(false));
      expect(orchestrator.isAvailable()).toBe(false);
    });
  });

  describe('isActive', () => {
    it('returns true when enabled, mode set, and runtime available', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime());
      expect(orchestrator.isActive()).toBe(true);
    });

    it('returns false when disabled', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, createMockRuntime());
      expect(orchestrator.isActive()).toBe(false);
    });

    it('returns false when runtime not available', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), null);
      expect(orchestrator.isActive()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns full status information', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime());
      const status = orchestrator.getStatus();

      expect(status.mode).toBe('auto-allow');
      expect(status.enabled).toBe(true);
      expect(status.platform).toBe('darwin');
      expect(status.runtimeAvailable).toBe(true);
      expect(status.runtimeName).toBe('mock-seatbelt');
      expect(status.config).toEqual(enabledConfig());
    });

    it('returns null platform when no runtime', () => {
      const orchestrator = new SandboxOrchestrator(DEFAULT_SANDBOX_CONFIG, null);
      const status = orchestrator.getStatus();
      expect(status.platform).toBeNull();
      expect(status.runtimeName).toBeNull();
      expect(status.runtimeAvailable).toBe(false);
    });

    it('includes proxy status when proxy is running', () => {
      const mockProxy = createMockProxyManager(true, 9999);
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime(), mockProxy);
      const status = orchestrator.getStatus();
      expect(status.proxyRunning).toBe(true);
      expect(status.proxyPort).toBe(9999);
    });

    it('includes proxy status when proxy is not running', () => {
      const mockProxy = createMockProxyManager(false, null);
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime(), mockProxy);
      const status = orchestrator.getStatus();
      expect(status.proxyRunning).toBe(false);
      expect(status.proxyPort).toBeNull();
    });

    it('includes proxy status when no proxy manager', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime());
      const status = orchestrator.getStatus();
      expect(status.proxyRunning).toBe(false);
      expect(status.proxyPort).toBeNull();
    });
  });

  describe('proxy integration', () => {
    it('injects proxy env vars into wrapped command', () => {
      const mockProxy = createMockProxyManager(true, 8888);
      const mockRuntime = createMockRuntime();
      const wrapSpy = vi.spyOn(mockRuntime, 'wrapCommand');

      const orchestrator = new SandboxOrchestrator(enabledConfig(), mockRuntime, mockProxy);
      orchestrator.shouldSandbox('curl https://example.com', '/tmp');

      expect(wrapSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          env: {
            HTTP_PROXY: 'http://127.0.0.1:8888',
            HTTPS_PROXY: 'http://127.0.0.1:8888',
          },
        })
      );
    });

    it('passes empty env when proxy is not running', () => {
      const mockProxy = createMockProxyManager(false, null);
      const mockRuntime = createMockRuntime();
      const wrapSpy = vi.spyOn(mockRuntime, 'wrapCommand');

      const orchestrator = new SandboxOrchestrator(enabledConfig(), mockRuntime, mockProxy);
      orchestrator.shouldSandbox('curl https://example.com', '/tmp');

      expect(wrapSpy).toHaveBeenCalledWith(expect.objectContaining({ env: {} }));
    });

    it('getProxyManager returns the proxy manager', () => {
      const mockProxy = createMockProxyManager(true, 8888);
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime(), mockProxy);
      expect(orchestrator.getProxyManager()).toBe(mockProxy);
    });
  });

  describe('stats tracking', () => {
    it('recordSandboxed increments counter', () => {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.recordSandboxed();
      orchestrator.recordSandboxed();
      expect(orchestrator.getStats().sandboxed).toBe(2);
    });

    it('recordUnsandboxed increments counter', () => {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.recordUnsandboxed();
      expect(orchestrator.getStats().unsandboxed).toBe(1);
    });

    it('recordBlocked increments counter', () => {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.recordBlocked();
      orchestrator.recordBlocked();
      orchestrator.recordBlocked();
      expect(orchestrator.getStats().blocked).toBe(3);
    });

    it('recordViolations increments by count', () => {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.recordViolations(5);
      orchestrator.recordViolations(3);
      expect(orchestrator.getStats().violations).toBe(8);
    });

    it('getStats returns a snapshot (mutation-safe)', () => {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.recordSandboxed();
      const stats1 = orchestrator.getStats();
      stats1.sandboxed = 999;
      expect(orchestrator.getStats().sandboxed).toBe(1);
    });

    it('resetStats zeroes all counters', () => {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.recordSandboxed();
      orchestrator.recordUnsandboxed();
      orchestrator.recordBlocked();
      orchestrator.recordViolations(3);
      orchestrator.resetStats();
      expect(orchestrator.getStats()).toEqual({
        sandboxed: 0,
        unsandboxed: 0,
        blocked: 0,
        violations: 0,
      });
    });

    it('getStatus includes stats', () => {
      const orchestrator = new SandboxOrchestrator(enabledConfig(), createMockRuntime());
      orchestrator.recordSandboxed();
      orchestrator.recordBlocked();
      const status = orchestrator.getStatus();
      expect(status.stats).toEqual({
        sandboxed: 1,
        unsandboxed: 0,
        blocked: 1,
        violations: 0,
      });
    });

    it('recordViolation delegates to store and increments stats', async () => {
      const mockStore = {
        record: vi.fn().mockResolvedValue(undefined),
      } as unknown as ViolationLogStore;

      const orchestrator = new SandboxOrchestrator();
      orchestrator.setViolationStore(mockStore);

      const violation: SandboxViolation = {
        type: 'filesystem',
        command: 'cat /etc/shadow',
        blockedBy: 'sandbox',
        timestamp: new Date(),
        detail: 'deny file-read-data',
      };

      await orchestrator.recordViolation(violation);

      expect(orchestrator.getStats().violations).toBe(1);
      expect(mockStore.record).toHaveBeenCalledWith(violation);
    });
  });
});
