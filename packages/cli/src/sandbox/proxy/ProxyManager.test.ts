import { describe, it, expect, afterEach } from 'vitest';
import { ProxyManager } from './ProxyManager.js';
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

    it('stop when not started is safe', async () => {
      manager = new ProxyManager(enabledConfig());
      await manager.stop(); // should not throw
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
