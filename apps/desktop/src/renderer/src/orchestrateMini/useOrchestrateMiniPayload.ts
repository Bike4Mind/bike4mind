import { useEffect, useState } from 'react';
import type { OrchestrateMiniApi } from '@shared/ipc';
import { parseOrchestrateMiniPayload, type OrchestrateMiniPayload } from '@shared/orchestrateMini';

/** The Orchestrate mini window's bridge (preload/orchestrateMini.ts); undefined in any other window. */
export function orchestrateMiniApi(): OrchestrateMiniApi | undefined {
  return window.b4mOrchestrateMini;
}

/**
 * The latest payload main relayed, parsed on receipt: a malformed one is dropped and the last good one
 * stays. Seeded with a pull so the first paint is not empty.
 */
export function useOrchestrateMiniPayload(api: OrchestrateMiniApi | undefined): OrchestrateMiniPayload | null {
  const [payload, setPayload] = useState<OrchestrateMiniPayload | null>(null);
  useEffect(() => {
    if (!api) return;
    let pushed = false;
    const accept = (value: unknown) => {
      const parsed = parseOrchestrateMiniPayload(value);
      if (parsed === undefined) {
        console.warn('[orchestrate-mini] dropped a payload that does not match the schema');
        return;
      }
      setPayload(parsed);
    };
    const unsubscribe = api.onSnapshot(value => {
      pushed = true;
      accept(value);
    });
    // A push that lands first is newer than this pull's answer, which is then dropped.
    api
      .getSnapshot()
      .then(first => {
        if (!pushed) accept(first);
      })
      .catch((error: unknown) => console.error('[orchestrate-mini] snapshot read failed', error));
    return unsubscribe;
  }, [api]);
  return payload;
}
