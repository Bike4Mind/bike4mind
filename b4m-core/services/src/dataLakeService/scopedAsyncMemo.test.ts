import { describe, it, expect, vi } from 'vitest';
import { createScopedAsyncMemo } from './scopedAsyncMemo';

describe('createScopedAsyncMemo', () => {
  const scope = () => ({});

  it('resolves once per (scope, key) and hands every later caller the same answer', async () => {
    const read = vi.fn(async () => 'rows');
    const memo = createScopedAsyncMemo<string>();
    const turn = scope();

    expect(await memo(turn, 'k', read)).toBe('rows');
    expect(await memo(turn, 'k', read)).toBe('rows');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    // The point of caching the PROMISE rather than the settled value: the knowledge tools can
    // reach the same read before the first has resolved, and two reads would both be issued.
    const read = vi.fn(async () => 'rows');
    const memo = createScopedAsyncMemo<string>();
    const turn = scope();

    expect(await Promise.all([memo(turn, 'k', read), memo(turn, 'k', read)])).toEqual(['rows', 'rows']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does NOT share an entry between two scopes', async () => {
    // Two turns are two requests. A hit across them is the process-lifetime cache this exists to
    // avoid being - on an authorization read that means honoring a grant revoked a request ago.
    const read = vi.fn(async () => 'rows');
    const memo = createScopedAsyncMemo<string>();

    await memo(scope(), 'k', read);
    await memo(scope(), 'k', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does NOT share an entry between two keys in one scope', async () => {
    const read = vi.fn(async (which: string) => which);
    const memo = createScopedAsyncMemo<string>();
    const turn = scope();

    expect(await memo(turn, 'a', () => read('a'))).toBe('a');
    expect(await memo(turn, 'b', () => read('b'))).toBe('b');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not share entries between two independent memos', async () => {
    // Each memo owns its own WeakMap, which is why callers never have to namespace their keys.
    const read = vi.fn(async () => 'rows');
    const turn = scope();

    await createScopedAsyncMemo<string>()(turn, 'k', read);
    await createScopedAsyncMemo<string>()(turn, 'k', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('evicts a rejection, so the next caller re-reads instead of inheriting the failure', async () => {
    // A failed read is not an answer. Cached, one transient failure would read as a settled
    // "this caller holds nothing" for the rest of the turn.
    const read = vi.fn().mockRejectedValueOnce(new Error('grants down')).mockResolvedValue('rows');
    const memo = createScopedAsyncMemo<string>();
    const turn = scope();

    await expect(memo(turn, 'k', read)).rejects.toThrow('grants down');
    expect(await memo(turn, 'k', read)).toBe('rows');
    // The third call proves the RETRY was memoized in turn - an eviction that also dropped the
    // replacement would leave the read un-collapsed for the rest of the scope.
    expect(await memo(turn, 'k', read)).toBe('rows');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects every concurrent caller of a failed read, and caches neither', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('grants down')).mockResolvedValue('rows');
    const memo = createScopedAsyncMemo<string>();
    const turn = scope();

    const [first, second] = await Promise.allSettled([memo(turn, 'k', read), memo(turn, 'k', read)]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    expect(read).toHaveBeenCalledTimes(1);
    expect(await memo(turn, 'k', read)).toBe('rows');
  });
});
