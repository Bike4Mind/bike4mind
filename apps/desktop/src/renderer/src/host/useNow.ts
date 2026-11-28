import { useSyncExternalStore } from 'react';

/** How often relative times ("Offline 5 min ago") are recomputed; they read in whole minutes. */
export const NOW_TICK_MS = 30_000;

type Clock = { now(): number; subscribe(listener: () => void): () => void };

/** One interval for every subscriber, running only while something is subscribed. */
export function createClock(tickMs: number = NOW_TICK_MS): Clock {
  const listeners = new Set<() => void>();
  let current = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    now: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // Refreshed on the first subscriber: the last tick may be old, and React re-reads after subscribing.
        current = Date.now();
        timer = setInterval(() => {
          current = Date.now();
          for (const notify of listeners) notify();
        }, tickMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || timer === null) return;
        clearInterval(timer);
        timer = null;
      };
    },
  };
}

const sharedClock = createClock();

/** The current time, re-read at most every 30 s by one app-wide interval. */
export function useNow(clock: Clock = sharedClock): number {
  return useSyncExternalStore(clock.subscribe, clock.now, clock.now);
}
