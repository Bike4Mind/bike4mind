/**
 * A per-scope async memo: one in-flight-or-settled read per (scope object, key) pair, living
 * exactly as long as the scope object does. Built for collapsing a read that ONE request issues N
 * times with byte-identical arguments - the knowledge tools resolve lake access once per TOOL
 * CALL, so a turn that calls both `search` and `retrieve` repeats every read behind that
 * resolution.
 *
 * THE SCOPE OBJECT IS THE LIFETIME: entries are held in a WeakMap keyed on it, so they become
 * unreachable the moment the request's own context object does. That is the whole reason this is
 * not a module-level `Map` keyed on a user id - these services run in a long-lived Fargate task,
 * so such a Map would be process-lifetime, and on an authorization read (a grant row IS the
 * authorization) that means a revoked grant would keep honoring itself until the task recycled.
 *
 * REJECTIONS ARE EVICTED. A failed read is not an answer: caching one would turn a single
 * transient failure into "this caller holds nothing" for the rest of the scope, which every
 * caller here reads as a settled deny. The caller's own fail-closed handling still runs per
 * attempt, so a persistent failure keeps warning rather than going quiet after the first.
 *
 * THE KEY MUST COVER EVERY ARGUMENT THE MEMOIZED READ VARIES ON - two call sites that pass
 * deliberately different arguments must never share an entry. Prefer wrapping the memo in a
 * helper that derives the key from the arguments itself (see `grantedLakeReachForTurn`) over
 * asking each call site to build one correctly.
 */
export type ScopedAsyncMemo<T> = (scope: object, key: string, resolve: () => Promise<T>) => Promise<T>;

/** One independent memo, with its own WeakMap - so callers never have to namespace their keys. */
export function createScopedAsyncMemo<T>(): ScopedAsyncMemo<T> {
  const byScope = new WeakMap<object, Map<string, Promise<T>>>();

  return (scope, key, resolve) => {
    const entries = byScope.get(scope) ?? new Map<string, Promise<T>>();
    byScope.set(scope, entries);

    const memoized = entries.get(key);
    if (memoized) return memoized;

    const pending = resolve();
    entries.set(key, pending);
    // Eviction lives here rather than at the caller: the caller awaits `pending` and handles the
    // rejection itself, but only this side can un-cache it. Identity-guarded so a failure can only
    // ever evict its OWN entry - no caller today can nest or replace one, but a delete keyed on the
    // string alone would make doing so drop a live read.
    pending.catch(() => {
      if (entries.get(key) === pending) entries.delete(key);
    });
    return pending;
  };
}
