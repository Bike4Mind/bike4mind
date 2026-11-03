import { useEffect, useState } from 'react';
import type { LocalUsageResult, UsageWindowId } from '@shared/usage';

/**
 * One window of self-hosted model usage, counted in main from this device's conversations.
 *
 * `reload` is the screen's refresh counter: any value past the first reads past main's cache.
 * Null until the first answer for the current window lands. A refresh keeps the previous answer
 * on screen until the new one arrives, so the section does not drop out and back in.
 */
export function useLocalUsage(windowId: UsageWindowId, reload: number): LocalUsageResult | null {
  const [answer, setAnswer] = useState<{ windowId: UsageWindowId; result: LocalUsageResult } | null>(null);

  useEffect(() => {
    let current = true;
    void window.b4m.usage.getLocal(windowId, reload > 0).then(result => {
      if (current) setAnswer({ windowId, result });
    });
    return () => {
      current = false;
    };
  }, [windowId, reload]);

  return answer?.windowId === windowId ? answer.result : null;
}
