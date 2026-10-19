import { useEffect, useState } from 'react';

/** Re-renders the caller once a minute so a relative time computed at render does not go stale. */
export function useMinuteTick(active = true): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [active]);
}
