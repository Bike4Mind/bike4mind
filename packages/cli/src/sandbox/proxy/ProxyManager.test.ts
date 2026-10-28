import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { ProxyManager } from './ProxyManager.js';
import { HttpConnectProxy } from './HttpConnectProxy.js';
import type { NetworkConfig } from '../types.js';

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

  describe('unix socket bridge', () => {
    it('is off by default', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.start();
      expect(manager.getUnixSocketPath()).toBeNull();
    });

    it('forwards the socket to the filtering proxy and removes it on stop', async () => {
      manager = new ProxyManager(enabledConfig(), { unixSocketBridge: true });
      await manager.start();
      const socketPath = manager.getUnixSocketPath();
      expect(socketPath).not.toBeNull();

      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath!, () => socket.write('CONNECT blocked.invalid:443 HTTP/1.1\r\n\r\n'));
        let data = '';
        socket.on('data', chunk => (data += chunk));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(reply).toContain('403');

      await manager.stop();
      expect(manager.getUnixSocketPath()).toBeNull();
      expect(existsSync(path.dirname(socketPath!))).toBe(false);
    });

    it('stops and drops open connections instead of waiting for them', async () => {
      manager = new ProxyManager(enabledConfig(), { unixSocketBridge: true });
      await manager.start();
      const socket = net.connect(manager.getUnixSocketPath()!);
      const closed = new Promise(resolve => socket.on('close', resolve));
      socket.on('error', () => {});
      await new Promise(resolve => socket.on('connect', resolve));

      await manager.stop();
      await closed;
      expect(manager.isRunning()).toBe(false);
    });

    it('fails the start and stops the proxy when the socket cannot be created', async () => {
      const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue('/nonexistent-b4m-test-dir');
      try {
        manager = new ProxyManager(enabledConfig(), { unixSocketBridge: true });
        await expect(manager.start()).rejects.toThrow();
        expect(manager.isRunning()).toBe(false);
        expect(manager.getUnixSocketPath()).toBeNull();
      } finally {
        tmpdirSpy.mockRestore();
      }
    });
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

  describe('events', () => {
    it('onEvent returns unsubscribe function', () => {
      manager = new ProxyManager(enabledConfig());
      const events: unknown[] = [];
      const unsub = manager.onEvent(e => events.push(e));
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });
});
