import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { createSessionHostMemory } from './sessionHostMemory';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

describe('createSessionHostMemory', () => {
  it('remembers remote sessions, most recent last, and forgets one reopened locally', () => {
    const storage = memoryStorage();
    const memory = createSessionHostMemory(() => storage);
    memory.remember('a', 'devbox');
    memory.remember('b', 'nas');
    memory.remember('a', 'devbox');
    expect([...memory.read()]).toEqual([
      ['b', 'nas'],
      ['a', 'devbox'],
    ]);

    memory.remember('b', LOCAL_HOST_ID);
    expect([...memory.read()]).toEqual([['a', 'devbox']]);
  });

  it('keeps only the most recent sessions', () => {
    const storage = memoryStorage();
    const memory = createSessionHostMemory(() => storage, 2);
    for (const id of ['a', 'b', 'c']) memory.remember(id, 'devbox');
    expect([...memory.read().keys()]).toEqual(['b', 'c']);
  });

  it('forgets every session of a removed host', () => {
    const storage = memoryStorage();
    const memory = createSessionHostMemory(() => storage);
    memory.remember('a', 'devbox');
    memory.remember('b', 'nas');
    memory.forgetHost('devbox');
    expect([...memory.read()]).toEqual([['b', 'nas']]);
  });

  it('reads nothing from a corrupt or blocked store', () => {
    const storage = memoryStorage();
    storage.items.set('b4m.sessionHosts.v1', '{"not":"pairs"}');
    expect(createSessionHostMemory(() => storage).read().size).toBe(0);
    const blocked = createSessionHostMemory(() => {
      throw new Error('blocked');
    });
    expect(blocked.read().size).toBe(0);
    expect(() => blocked.remember('a', 'devbox')).not.toThrow();
  });
});
