import { useCallback, useEffect, useState } from 'react';
import type { AccountUsageResult, UsageWindowId } from '@shared/usage';

export interface UsageQuery {
  /** Null until the first answer for the current window lands. */
  result: AccountUsageResult | null;
  refresh: () => void;
}

/**
 * One window of the account's spend history.
 *
 * Asked only while this screen is mounted, and never on a timer: these are aggregations over a
 * month of events, and a poll would re-run them forever to watch a figure about the past. The
 * cost of that choice is spend from another client landing only on the next refresh, which is
 * what `refresh` is for.
 *
 * A null result is how the caller tells "still reading" from "read nothing" - a zero-spend
 * window is a real answer and arrives as an ok result with zero totals.
 */
export function useAccountUsage(windowId: UsageWindowId): UsageQuery {
  const [result, setResult] = useState<AccountUsageResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    // Cleared first, so the charts never draw one window's bars under the other's heading
    // while the new read is in flight.
    setResult(null);
    // The first attempt reads through main's cache; a refresh is the one thing that must not.
    void window.b4m.usage.getHistory(windowId, attempt > 0).then(next => {
      if (current) setResult(next);
    });
    return () => {
      current = false;
    };
  }, [windowId, attempt]);

  const refresh = useCallback(() => setAttempt(current => current + 1), []);

  return { result, refresh };
}
