import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/**
 * The preview's master clock. `isPlaying` is React state (it changes on play and pause only); the time itself lives
 * in a small store that ticks every animation frame, so only the components that read it through `usePlaybackTime`
 * re-render per frame, not the whole editor.
 */
export type PlaybackClock = {
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  seek: (ms: number) => void;
  getTimeMs: () => number;
  subscribe: (onChange: () => void) => () => void;
};

const createTimeStore = () => {
  let timeMs = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => timeMs,
    set: (next: number) => {
      if (next === timeMs) return;
      timeMs = next;
      listeners.forEach(listener => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * Wall-clock driven (requestAnimationFrame), not slaved to any one media element, so a gap with nothing playing
 * still advances; each element is synced to it instead. Playing to the end stops at the end.
 */
export function usePlaybackClock(durationMs: number): PlaybackClock {
  const [isPlaying, setIsPlaying] = useState(false);
  const [store] = useState(createTimeStore);
  const anchorRef = useRef({ wallMs: 0, timeMs: 0 });

  // Shortening the timeline pulls a playhead past the new end back onto it.
  useEffect(() => {
    if (store.get() > durationMs) store.set(durationMs);
  }, [store, durationMs]);

  useEffect(() => {
    if (!isPlaying) return;
    anchorRef.current = { wallMs: performance.now(), timeMs: store.get() };
    let frame = 0;
    const tick = () => {
      const next = anchorRef.current.timeMs + (performance.now() - anchorRef.current.wallMs);
      if (next >= durationMs) {
        store.set(durationMs);
        setIsPlaying(false);
        return;
      }
      store.set(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [store, isPlaying, durationMs]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.min(Math.max(0, ms), durationMs);
      anchorRef.current = { wallMs: performance.now(), timeMs: clamped };
      store.set(clamped);
    },
    [store, durationMs]
  );

  const play = useCallback(() => {
    // Play from the top once the end is reached, as a video player does.
    if (store.get() >= durationMs) store.set(0);
    setIsPlaying(true);
  }, [store, durationMs]);

  const pause = useCallback(() => setIsPlaying(false), []);

  // rAF stops in a hidden tab, so the media elements would play on unsynced; pause the preview instead.
  useEffect(() => {
    const pauseWhenHidden = () => document.hidden && setIsPlaying(false);
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, []);

  return useMemo(
    () => ({ isPlaying, play, pause, seek, getTimeMs: store.get, subscribe: store.subscribe }),
    [isPlaying, play, pause, seek, store]
  );
}

/** The clock's current time in ms; the calling component re-renders on every tick. */
export const usePlaybackTime = (clock: PlaybackClock): number => useSyncExternalStore(clock.subscribe, clock.getTimeMs);
