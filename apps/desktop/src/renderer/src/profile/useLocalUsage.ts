import { useEffect, useRef, useState } from 'react';
import { localUsageReadFailed, type LocalUsageResult, type UsageWindowId } from '@shared/usage';

/**
 * One window of local model usage. Mounting and a new `reload` read past main's cache; an answer
 * read under another `scopeKey` is never returned, and within one key the last answer stays until the next.
 */
export function useLocalUsage(windowId: UsageWindowId, reload: number, scopeKey: string): LocalUsageResult | null {
  const [answer, setAnswer] = useState<{ scopeKey: string; result: LocalUsageResult } | null>(null);
  const forcedFor = useRef<number | null>(null);

  useEffect(() => {
    let current = true;
    const force = reload !== forcedFor.current;
    forcedFor.current = reload;
    void window.b4m.usage
      .getLocal(windowId, force)
      .catch((err: unknown): LocalUsageResult => ({
        ok: false,
        error: localUsageReadFailed(
          err instanceof Error && err.message.trim() ? err.message : 'the request to the app failed'
        ),
      }))
      .then(result => {
        if (current) setAnswer({ scopeKey, result });
      });
    return () => {
      current = false;
    };
  }, [windowId, reload, scopeKey]);

  return answer?.scopeKey === scopeKey ? answer.result : null;
}
