import { useEffect, useState } from 'react';
import { isLocalModel, type CreationTool } from '@shared/chat';

const NONE: CreationTool[] = [];

// Module-level so a second blank chat draws its cards on the first frame instead of after a round trip.
const cache = new Map<string, CreationTool[]>();

/**
 * The generation tools a Chat turn on `model` would be offered, or null until main has answered
 * once for this account. Asked again only when a blank chat is shown (`sessionId`) or its model
 * changes, never on render: main answers from the same short caches the next turn reads, and the
 * last answer stays on screen while it does. A local model is never offered one, so it costs no
 * round trip at all.
 */
export function useCreationTools(
  account: string,
  sessionId: string | null,
  model: string | undefined
): CreationTool[] | null {
  const local = !!model && isLocalModel(model);
  const key = `${account}\n${model ?? ''}`;
  const [last, setLast] = useState<{ account: string; tools: CreationTool[] } | null>(null);

  useEffect(() => {
    if (sessionId === null || !model || local) return;
    let live = true;
    window.b4m.chat
      .listCreationTools(model)
      .then(next => {
        const previous = cache.get(key);
        const tools = previous && sameTools(previous, next) ? previous : next;
        cache.set(key, tools);
        if (live)
          setLast(current => (current?.account === account && current.tools === tools ? current : { account, tools }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account, key, local, model, sessionId]);

  if (local) return NONE;
  return cache.get(key) ?? (last?.account === account ? last.tools : null);
}

function sameTools(a: readonly CreationTool[], b: readonly CreationTool[]): boolean {
  return a.length === b.length && a.every((tool, i) => tool.name === b[i].name);
}

/** Test seam: the cache outlives a test's render. */
export function resetCreationToolsCache(): void {
  cache.clear();
}
