import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import { createSessionListCache } from './sessionListCache';

const row = (id: string): ChatSessionSummary =>
  ({
    id,
    title: id,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  }) as ChatSessionSummary;

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe('createSessionListCache', () => {
  it('round-trips each host separately, capped at the limit', () => {
    const storage = memoryStorage();
    const cache = createSessionListCache(() => storage, 2);
    cache.write('devbox', [row('a'), row('b'), row('c')]);
    cache.write('laptop', [row('x')]);
    expect(cache.read('devbox').map(r => r.id)).toEqual(['a', 'b']);
    expect(cache.read('laptop').map(r => r.id)).toEqual(['x']);
    cache.forget('devbox');
    expect(cache.read('devbox')).toEqual([]);
  });

  it('reads nothing from a corrupt or malformed entry', () => {
    const storage = memoryStorage();
    const cache = createSessionListCache(() => storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    storage.items.set('b4m.hostSessions.v1:devbox', '{not json');
    expect(cache.read('devbox')).toEqual([]);
    storage.items.set('b4m.hostSessions.v1:devbox', JSON.stringify([{ id: 1 }, row('ok')]));
    expect(cache.read('devbox').map(r => r.id)).toEqual(['ok']);
    warn.mockRestore();
  });

  it('survives a storage that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = createSessionListCache(() => {
      throw new Error('denied');
    });
    expect(() => cache.write('devbox', [row('a')])).not.toThrow();
    expect(cache.read('devbox')).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
