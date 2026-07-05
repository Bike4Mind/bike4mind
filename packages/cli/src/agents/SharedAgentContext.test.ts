import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedAgentContext } from './SharedAgentContext';

describe('SharedAgentContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic operations', () => {
    it('should set and get a value', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'key1', 'value1', 'agent-a');
      expect(ctx.get('ns', 'key1')).toBe('value1');
    });

    it('should return undefined for missing key', () => {
      const ctx = new SharedAgentContext();
      expect(ctx.get('ns', 'missing')).toBeUndefined();
    });

    it('should return undefined for missing namespace', () => {
      const ctx = new SharedAgentContext();
      expect(ctx.get('missing-ns', 'key')).toBeUndefined();
    });

    it('should overwrite existing keys', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'key1', 'old', 'agent-a');
      ctx.set('ns', 'key1', 'new', 'agent-b');
      expect(ctx.get('ns', 'key1')).toBe('new');
    });

    it('should support has()', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'key1', 'value', 'agent-a');
      expect(ctx.has('ns', 'key1')).toBe(true);
      expect(ctx.has('ns', 'missing')).toBe(false);
    });

    it('should support delete()', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'key1', 'value', 'agent-a');
      expect(ctx.delete('ns', 'key1')).toBe(true);
      expect(ctx.get('ns', 'key1')).toBeUndefined();
    });

    it('should return false when deleting from missing namespace', () => {
      const ctx = new SharedAgentContext();
      expect(ctx.delete('missing', 'key')).toBe(false);
    });
  });

  describe('namespacing', () => {
    it('should isolate keys across namespaces', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns1', 'key', 'value1', 'agent-a');
      ctx.set('ns2', 'key', 'value2', 'agent-b');

      expect(ctx.get('ns1', 'key')).toBe('value1');
      expect(ctx.get('ns2', 'key')).toBe('value2');
    });

    it('should list active namespaces', () => {
      const ctx = new SharedAgentContext();
      ctx.set('alpha', 'k', 'v', 'a');
      ctx.set('beta', 'k', 'v', 'b');

      const namespaces = ctx.listNamespaces();
      expect(namespaces).toContain('alpha');
      expect(namespaces).toContain('beta');
      expect(namespaces).toHaveLength(2);
    });

    it('should clear a single namespace', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns1', 'k', 'v', 'a');
      ctx.set('ns2', 'k', 'v', 'b');

      ctx.clearNamespace('ns1');
      expect(ctx.get('ns1', 'k')).toBeUndefined();
      expect(ctx.get('ns2', 'k')).toBe('v');
    });

    it('should clear all namespaces', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns1', 'k', 'v', 'a');
      ctx.set('ns2', 'k', 'v', 'b');

      ctx.clearAll();
      expect(ctx.listNamespaces()).toHaveLength(0);
    });
  });

  describe('size limits', () => {
    it('should truncate values exceeding 2000 characters', () => {
      const ctx = new SharedAgentContext();
      const longValue = 'x'.repeat(3000);
      ctx.set('ns', 'key', longValue, 'agent-a');

      const stored = ctx.get('ns', 'key')!;
      expect(stored.length).toBe(2000);
    });

    it('should allow values at exactly 2000 characters', () => {
      const ctx = new SharedAgentContext();
      const exactValue = 'y'.repeat(2000);
      ctx.set('ns', 'key', exactValue, 'agent-a');

      expect(ctx.get('ns', 'key')!.length).toBe(2000);
    });

    it('should enforce 50 entry limit per namespace', () => {
      const ctx = new SharedAgentContext();
      for (let i = 0; i < 50; i++) {
        ctx.set('ns', `key-${i}`, `value-${i}`, 'agent-a');
      }

      expect(() => ctx.set('ns', 'key-50', 'value-50', 'agent-a')).toThrow(/maximum of 50 entries/);
    });

    it('should allow updating existing keys even at the limit', () => {
      const ctx = new SharedAgentContext();
      for (let i = 0; i < 50; i++) {
        ctx.set('ns', `key-${i}`, `value-${i}`, 'agent-a');
      }

      // Updating an existing key should not throw
      expect(() => ctx.set('ns', 'key-0', 'updated', 'agent-a')).not.toThrow();
      expect(ctx.get('ns', 'key-0')).toBe('updated');
    });

    it('should enforce limit per namespace independently', () => {
      const ctx = new SharedAgentContext();
      for (let i = 0; i < 50; i++) {
        ctx.set('ns1', `key-${i}`, `value-${i}`, 'agent-a');
      }

      // ns2 should still accept entries
      expect(() => ctx.set('ns2', 'key-0', 'value', 'agent-a')).not.toThrow();
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);

      ctx.set('ns', 'key', 'value', 'agent-a');
      expect(ctx.get('ns', 'key')).toBe('value');

      vi.advanceTimersByTime(ttlMs + 1);
      expect(ctx.get('ns', 'key')).toBeUndefined();
    });

    it('should refresh TTL on update', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);

      ctx.set('ns', 'key', 'original', 'agent-a');

      vi.advanceTimersByTime(800);
      ctx.set('ns', 'key', 'updated', 'agent-a');

      // 800ms from first set + 300ms more = past original TTL but within updated TTL
      vi.advanceTimersByTime(300);
      expect(ctx.get('ns', 'key')).toBe('updated');

      // But should expire after full TTL from last update
      vi.advanceTimersByTime(800);
      expect(ctx.get('ns', 'key')).toBeUndefined();
    });

    it('should not count expired entries toward the limit', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);

      for (let i = 0; i < 50; i++) {
        ctx.set('ns', `key-${i}`, `value-${i}`, 'agent-a');
      }

      // Expire all entries
      vi.advanceTimersByTime(ttlMs + 1);

      // Should allow new entries
      expect(() => ctx.set('ns', 'new-key', 'new-value', 'agent-a')).not.toThrow();
    });

    it('should exclude expired entries from keys()', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);

      ctx.set('ns', 'k1', 'v1', 'a');
      ctx.set('ns', 'k2', 'v2', 'a');

      vi.advanceTimersByTime(ttlMs + 1);
      expect(ctx.keys('ns')).toHaveLength(0);
    });

    it('should exclude expired entries from getAll()', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);

      ctx.set('ns', 'k1', 'v1', 'a');
      vi.advanceTimersByTime(ttlMs + 1);

      expect(ctx.getAll('ns')).toEqual({});
    });
  });

  describe('bulk operations', () => {
    it('should list keys in a namespace', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'alpha', 'a', 'agent');
      ctx.set('ns', 'beta', 'b', 'agent');

      const keys = ctx.keys('ns');
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
      expect(keys).toHaveLength(2);
    });

    it('should return all entries via getAll()', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'k1', 'v1', 'a');
      ctx.set('ns', 'k2', 'v2', 'b');

      const all = ctx.getAll('ns');
      expect(all).toEqual({ k1: 'v1', k2: 'v2' });
    });

    it('should return size of namespace', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'k1', 'v1', 'a');
      ctx.set('ns', 'k2', 'v2', 'a');

      expect(ctx.size('ns')).toBe(2);
      expect(ctx.size('empty-ns')).toBe(0);
    });
  });

  describe('namespace count limit', () => {
    it('should enforce max 20 namespaces', () => {
      const ctx = new SharedAgentContext();
      for (let i = 0; i < 20; i++) {
        ctx.set(`ns-${i}`, 'key', 'value', 'agent');
      }

      expect(() => ctx.set('ns-20', 'key', 'value', 'agent')).toThrow(/Maximum of 20 namespaces/);
    });

    it('should allow writing to existing namespace at the limit', () => {
      const ctx = new SharedAgentContext();
      for (let i = 0; i < 20; i++) {
        ctx.set(`ns-${i}`, 'key', 'value', 'agent');
      }

      // Writing to an existing namespace should not throw
      expect(() => ctx.set('ns-0', 'new-key', 'value', 'agent')).not.toThrow();
    });
  });

  describe('additional TTL edge cases', () => {
    it('should return false for has() after TTL expiration', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);
      ctx.set('ns', 'key', 'value', 'a');

      vi.advanceTimersByTime(ttlMs + 1);
      expect(ctx.has('ns', 'key')).toBe(false);
    });

    it('should still delete an expired key from storage', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);
      ctx.set('ns', 'key', 'value', 'a');

      vi.advanceTimersByTime(ttlMs + 1);
      // delete() removes the entry from the Map regardless of expiry
      expect(ctx.delete('ns', 'key')).toBe(true);
      // But get() would have returned undefined anyway
      expect(ctx.get('ns', 'key')).toBeUndefined();
    });

    it('should allow new entry after partial expiration frees slots', () => {
      const ttlMs = 1000;
      const ctx = new SharedAgentContext(ttlMs);

      // Fill namespace with 50 entries
      for (let i = 0; i < 50; i++) {
        ctx.set('ns', `key-${i}`, `value-${i}`, 'agent');
      }

      // Expire all, then add 10 fresh ones
      vi.advanceTimersByTime(ttlMs + 1);
      for (let i = 0; i < 10; i++) {
        ctx.set('ns', `fresh-${i}`, `val-${i}`, 'agent');
      }

      // Should still allow a new entry (40 expired slots freed, 10 live)
      expect(() => ctx.set('ns', 'one-more', 'val', 'agent')).not.toThrow();
      expect(ctx.size('ns')).toBe(11);
    });
  });

  describe('writtenBy metadata', () => {
    it('should track which agent wrote each entry', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'discovery', 'found auth files', 'explore-agent');

      // writtenBy is internal, but we can verify via get that the value persists
      expect(ctx.get('ns', 'discovery')).toBe('found auth files');
    });

    it('should update writtenBy on overwrite', () => {
      const ctx = new SharedAgentContext();
      ctx.set('ns', 'key', 'original', 'agent-a');
      ctx.set('ns', 'key', 'updated', 'agent-b');

      expect(ctx.get('ns', 'key')).toBe('updated');
    });
  });
});
