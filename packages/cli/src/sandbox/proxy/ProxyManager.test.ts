import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import net from 'net';
import { ProxyManager } from './ProxyManager.js';
import { HttpConnectProxy, type ProxyEvent } from './HttpConnectProxy.js';
import { UnixSocketRelay } from './UnixSocketRelay.js';
import type { NetworkConfig } from '../types.js';

/** Send a CONNECT for a domain outside the allowlist and return the proxy's status line. */
function connectBlocked(connectOptions: net.NetConnectOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(connectOptions, () => {
      socket.write('CONNECT blocked.invalid:443 HTTP/1.1\r\nHost: blocked.invalid:443\r\n\r\n');
    });
    let response = '';
    socket.on('data', chunk => (response += chunk.toString()));
    socket.on('end', () => resolve(response.split('\r\n')[0]));
    socket.on('error', reject);
  });
}

function enabledConfig(overrides?: Partial<NetworkConfig>): NetworkConfig {
  return {
    enabled: true,
    allowedDomains: ['example.com', '*.github.com'],
    ...overrides,
  };
}

describe('ProxyManager', () => {
  let manager: ProxyManager;

  afterEach(async () => {
    if (manager?.isRunning()) {
      await manager.stop();
    }
  });

  describe('start/stop', () => {
    it('starts proxy when enabled', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      expect(manager.isRunning()).toBe(true);
      expect(manager.getPort()).toBeGreaterThan(0);
    });

    it('does not start when disabled', async () => {
      manager = new ProxyManager({ enabled: false, allowedDomains: ['example.com'] });
      await manager.start();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getPort()).toBeNull();
    });

    it('stops cleanly', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      await manager.stop();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getPort()).toBeNull();
    });

    it('double start is idempotent', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      const port = manager.getPort();
      await manager.start(); // should not throw
      expect(manager.getPort()).toBe(port);
    });

    it('concurrent starts share one in-flight promise (no orphaned second proxy)', async () => {
      manager = new ProxyManager(enabledConfig());
      // Overlapping starts must dedupe on the in-flight promise, not just isRunning():
      // both would otherwise see isRunning() false and each bind a server, leaking one.
      const p1 = manager.start();
      const p2 = manager.start();
      const p3 = manager.start();
      expect(p2).toBe(p1);
      expect(p3).toBe(p1);
      await Promise.all([p1, p2, p3]);
      expect(manager.isRunning()).toBe(true);
      expect(manager.getPort()).toBeGreaterThan(0);
    });

    it('stop when not started is safe', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.stop(); // should not throw
    });

    it('stop() waits for an in-flight start() to finish before tearing down', async () => {
      // Pins the join added for the orphaned-listener leak: stop() must not proceed
      // while start() is still binding. Gate start() on a manual promise; stop() must
      // stay pending until it resolves. Without the join, stop() settles immediately.
      let resolveStart!: (port: number) => void;
      const gate = new Promise<number>(r => {
        resolveStart = r;
      });
      const startSpy = vi.spyOn(HttpConnectProxy.prototype, 'start').mockReturnValueOnce(gate);
      const stopSpy = vi.spyOn(HttpConnectProxy.prototype, 'stop').mockResolvedValue(undefined);
      manager = new ProxyManager(enabledConfig());

      const startP = manager.start();
      let stopSettled = false;
      const stopP = manager.stop().then(() => {
        stopSettled = true;
      });

      await new Promise(r => setTimeout(r, 10));
      expect(stopSettled).toBe(false); // still joined to the in-flight start

      resolveStart(0);
      await Promise.all([startP, stopP]);
      expect(stopSettled).toBe(true);
      expect(stopSpy).toHaveBeenCalled();
      expect(manager.isRunning()).toBe(false);

      startSpy.mockRestore();
      stopSpy.mockRestore();
    });

    it('stop() resolves and clears the proxy even when the in-flight start() rejects', async () => {
      const startSpy = vi.spyOn(HttpConnectProxy.prototype, 'start').mockRejectedValueOnce(new Error('bind failed'));
      const stopSpy = vi.spyOn(HttpConnectProxy.prototype, 'stop').mockResolvedValue(undefined);
      manager = new ProxyManager(enabledConfig());

      const startP = manager.start().catch(() => {}); // start rejects; caller swallows
      await expect(manager.stop()).resolves.toBeUndefined(); // join swallows the rejection
      await startP;

      expect(manager.isRunning()).toBe(false);
      expect(manager.getPort()).toBeNull();

      startSpy.mockRestore();
      stopSpy.mockRestore();
    });

    it('setEnabled flips the live flag start() honors (real class, happy path)', async () => {
      // Constructed disabled: start() must no-op until setEnabled(true) flips the
      // live flag the runtime toggle depends on; observable via isRunning().
      manager = new ProxyManager({ enabled: false, allowedDomains: ['example.com'] });
      await manager.start();
      expect(manager.isRunning()).toBe(false);

      manager.setEnabled(true);
      await manager.start();
      expect(manager.isRunning()).toBe(true);

      manager.setEnabled(false);
      await manager.stop();
      await manager.start();
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('getProxyEnv', () => {
    it('returns env vars when running', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      const env = manager.getProxyEnv();

      expect(env.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(env.http_proxy).toBe(env.HTTP_PROXY);
      expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
      expect(env.https_proxy).toBe(env.HTTP_PROXY);
      expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
      expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
      expect(env.NODE_USE_ENV_PROXY).toBe('1');
      expect(env.ALL_PROXY).toBe(env.HTTP_PROXY);
      expect(env.all_proxy).toBe(env.HTTP_PROXY);
    });

    it('returns empty when a running proxy reports no port', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      const portSpy = vi.spyOn(HttpConnectProxy.prototype, 'getPort').mockReturnValue(null);
      expect(manager.getProxyEnv()).toEqual({});
      portSpy.mockRestore();
    });

    it('returns empty when not running', () => {
      manager = new ProxyManager(enabledConfig());
      expect(manager.getProxyEnv()).toEqual({});
    });
  });

  describe('domain management', () => {
    it('addAllowedDomain adds new domain', () => {
      manager = new ProxyManager(enabledConfig());
      manager.addAllowedDomain('newdomain.com');
      expect(manager.getAllowedDomains()).toContain('newdomain.com');
    });

    it('addAllowedDomain is idempotent', () => {
      manager = new ProxyManager(enabledConfig());
      manager.addAllowedDomain('example.com'); // already in list
      const domains = manager.getAllowedDomains();
      const count = domains.filter(d => d === 'example.com').length;
      expect(count).toBe(1);
    });

    it('getAllowedDomains returns copy', () => {
      manager = new ProxyManager(enabledConfig());
      const domains = manager.getAllowedDomains();
      domains.push('mutated.com');
      expect(manager.getAllowedDomains()).not.toContain('mutated.com');
    });
  });

  describe('unix socket', () => {
    it('has no socket unless asked for one', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      expect(manager.getSocketPath()).toBeNull();
    });

    it('serves the filtering proxy on a unix socket and removes it on stop', async () => {
      manager = new ProxyManager(enabledConfig(), { unixSocket: true });
      await manager.start();
      const socketPath = manager.getSocketPath();

      expect(socketPath).not.toBeNull();
      await expect(connectBlocked({ path: socketPath! })).resolves.toBe('HTTP/1.1 403 Forbidden');

      await manager.stop();
      expect(manager.getSocketPath()).toBeNull();
      expect(existsSync(socketPath!)).toBe(false);
    });

    it('stops the proxy and rethrows when the socket cannot be created', async () => {
      const relaySpy = vi.spyOn(UnixSocketRelay.prototype, 'start').mockRejectedValueOnce(new Error('EADDRINUSE'));
      manager = new ProxyManager(enabledConfig(), { unixSocket: true });

      await expect(manager.start()).rejects.toThrow('EADDRINUSE');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getSocketPath()).toBeNull();
      relaySpy.mockRestore();
    });
  });

  describe('events', () => {
    it('forwards proxy decisions to subscribers', async () => {
      manager = new ProxyManager(enabledConfig());
      const events: ProxyEvent[] = [];
      manager.onEvent(e => events.push(e));
      await manager.start();

      await connectBlocked({ host: '127.0.0.1', port: manager.getPort()! });

      expect(events).toEqual([
        expect.objectContaining({ type: 'blocked', domain: 'blocked.invalid', method: 'CONNECT' }),
      ]);
    });

    it('onEvent returns unsubscribe function', () => {
      manager = new ProxyManager(enabledConfig());
      const events: unknown[] = [];
      const unsub = manager.onEvent(e => events.push(e));
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });
});
