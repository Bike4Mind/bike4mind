/**
 * Cycle through an array of copy variants on an interval. Designed for the
 * agent loading placeholders ("Thinking...", "Starting agent...") where a static
 * label during a multi-second wait reads as stalled.
 *
 * Resets to index 0 whenever the variants array identity changes, so callers
 * that conditionally swap copy lists (e.g. switching from STARTING_COPY to
 * THINKING_COPY) always start fresh.
 */

import { useEffect, useState } from 'react';

const DEFAULT_INTERVAL_MS = 2500;

export function useRotatingCopy<T extends readonly string[]>(
  variants: T,
  intervalMs: number = DEFAULT_INTERVAL_MS
): T[number] {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (variants.length <= 1) return;
    const id = setInterval(() => {
      setIndex(i => (i + 1) % variants.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [variants, intervalMs]);

  return variants[index] ?? variants[0];
}
