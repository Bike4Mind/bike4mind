import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The preview's master clock in timeline ms. It is wall-clock driven (requestAnimationFrame), not slaved to any one
 * media element, so a gap with nothing playing still advances; each element is synced to it instead. Playing to the
 * end stops at the end.
 */
export function usePlaybackClock(durationMs: number) {
  const [timeMs, setTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const anchorRef = useRef({ wallMs: 0, timeMs: 0 });
  const timeRef = useRef(0);
  useEffect(() => {
    timeRef.current = timeMs;
  }, [timeMs]);

  useEffect(() => {
    if (!isPlaying) return;
    anchorRef.current = { wallMs: performance.now(), timeMs: timeRef.current };
    let frame = 0;
    const tick = () => {
      const next = anchorRef.current.timeMs + (performance.now() - anchorRef.current.wallMs);
      if (next >= durationMs) {
        setTimeMs(durationMs);
        setIsPlaying(false);
        return;
      }
      setTimeMs(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, durationMs]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.min(Math.max(0, ms), durationMs);
      anchorRef.current = { wallMs: performance.now(), timeMs: clamped };
      setTimeMs(clamped);
    },
    [durationMs]
  );

  const play = useCallback(() => {
    // Play from the top once the end is reached, as a video player does.
    if (timeRef.current >= durationMs) setTimeMs(0);
    setIsPlaying(true);
  }, [durationMs]);

  const pause = useCallback(() => setIsPlaying(false), []);

  // rAF stops in a hidden tab, so the media elements would play on unsynced; pause the preview instead.
  useEffect(() => {
    const pauseWhenHidden = () => document.hidden && setIsPlaying(false);
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, []);

  return { timeMs: Math.min(timeMs, durationMs), isPlaying, play, pause, seek };
}
