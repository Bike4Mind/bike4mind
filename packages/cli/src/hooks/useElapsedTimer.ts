import { useEffect, useRef, useState } from 'react';

/**
 * Tracks elapsed seconds since `isActive` became true.
 * Resets to 0 when `isActive` becomes false.
 *
 * @param isActive - Whether the timer should be running
 * @param thresholdSeconds - Seconds before `isVisible` becomes true (default: 3)
 * @returns elapsed seconds and whether the threshold has been crossed
 */
export function useElapsedTimer(
  isActive: boolean,
  thresholdSeconds: number = 3
): { elapsed: number; isVisible: boolean } {
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      setElapsed(0);
      startTimeRef.current = null;
      return;
    }

    startTimeRef.current = Date.now();
    setElapsed(0);

    const interval = setInterval(() => {
      if (startTimeRef.current !== null) {
        setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive]);

  return { elapsed, isVisible: elapsed >= thresholdSeconds };
}
