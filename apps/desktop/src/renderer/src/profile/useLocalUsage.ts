import { useEffect, useRef, useState } from 'react';
import type { LocalUsageResult, UsageWindowId } from '@shared/usage';

const READ_FAILED: LocalUsageResult = { ok: false, error: 'Could not read local model usage.' };

/**
 * One window of self-hosted model usage, counted in main from this device's conversations.
 *
 * `reload` is the screen's refresh counter: a new value reads past main's cache once. `scopeKey`
 * names who is signed in, and an answer read under another key is never returned. Within one key
 * the last answer stays until the next lands, so a window toggle or a refresh does not drop the
 * section out and back in. Null until the first answer for this key.
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
