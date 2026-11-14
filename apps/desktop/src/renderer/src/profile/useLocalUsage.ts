import { useEffect, useRef, useState } from 'react';
import type { LocalUsageResult, UsageWindowId } from '@shared/usage';

const READ_FAILED: LocalUsageResult = { ok: false, error: 'Could not read local model usage.' };

/**
 * One window of local model usage. A new `reload` reads past main's cache; an answer read under
 * another `scopeKey` is never returned, and within one key the last answer stays until the next.
 */
export function useLocalUsage(windowId: UsageWindowId, reload: number, scopeKey: string): LocalUsageResult | null {
  const [answer, setAnswer] = useState<{ scopeKey: string; result: LocalUsageResult } | null>(null);
  const forcedFor = useRef(reload);

  useEffect(() => {
    let current = true;
    const force = reload !== forcedFor.current;
    forcedFor.current = reload;
    void window.b4m.usage
      .getLocal(windowId, force)
      .catch(() => READ_FAILED)
      .then(result => {
        if (current) setAnswer({ scopeKey, result });
      });
    return () => {
      current = false;
    };
  }, [windowId, reload, scopeKey]);

  return answer?.scopeKey === scopeKey ? answer.result : null;
}
