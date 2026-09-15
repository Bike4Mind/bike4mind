import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secretCache, SecretCacheManager } from './secretCache';

// Mock SST Config
vi.mock('sst/node/config', () => ({
  Config: {
    MONGODB_URI: 'mock-mongodb-uri',
    JWT_SECRET: 'mock-jwt-secret',
  },
}));

// TODO: Fix test
describe.skip('SecretCacheManager', () => {
  beforeEach(() => {
    secretCache.clearCache();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getInstance', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = SecretCacheManager.getInstance();
      const instance2 = SecretCacheManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getSecret', () => {
    it('should fetch and cache a secret', async () => {
      const secret = await secretCache.getSecret('MONGODB_URI');
      expect(secret).toBe('mock-mongodb-uri');
    });

    it('should return cached value within expiry time', async () => {
      await secretCache.getSecret('MONGODB_URI');

      const secret = await secretCache.getSecret('MONGODB_URI');
      expect(secret).toBe('mock-mongodb-uri');
    });

    it('should handle concurrent requests for the same secret', async () => {
      const promises = Array(5)
        .fill(null)
        .map(() => secretCache.getSecret('MONGODB_URI'));

      const results = await Promise.all(promises);
      expect(results.every(r => r === 'mock-mongodb-uri')).toBe(true);
    });

    it('should refresh cache after expiry', async () => {
      await secretCache.getSecret('MONGODB_URI');

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      const secret = await secretCache.getSecret('MONGODB_URI');
      expect(secret).toBe('mock-mongodb-uri');
    });
  });

  describe('clearCache', () => {
    it('should clear all cached secrets', async () => {
      await secretCache.getSecret('MONGODB_URI');

      secretCache.clearCache();

      const secret = await secretCache.getSecret('MONGODB_URI');
      expect(secret).toBe('mock-mongodb-uri');
    });
  });
});
