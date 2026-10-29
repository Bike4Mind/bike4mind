import { useEffect, useState } from 'react';
import { isLocalModel, type CreationTool } from '@shared/chat';

const NONE: CreationTool[] = [];

// Module-level so a second blank chat draws its cards on the first frame instead of after a round trip.
const cache = new Map<string, CreationTool[]>();

/**
 * Generation tools for this account and model, or null until main answers. Refresh on opening
 * a blank chat or changing its model, retaining only the same account/model's cached answer.
 * Local models need no lookup; a failed read falls back to text cards and retries on next opening.
 */
export function useCreationTools(
  account: string,
  sessionId: string | null,
  model: string | undefined
): CreationTool[] | null {
  const local = !!model && isLocalModel(model);
  const key = `${account}\n${model ?? ''}`;
  const [last, setLast] = useState<{ key: string; tools: CreationTool[] } | null>(null);

  useEffect(() => {
    if (sessionId === null || !model || local) return;
    let live = true;
    const load = async () => {
      try {
        const next = await window.b4m.chat.listCreationTools(model);
        if (!live) return;
        const previous = cache.get(key);
        const tools = previous && sameTools(previous, next) ? previous : next;
        cache.set(key, tools);
        setLast(current => (current?.key === key && current.tools === tools ? current : { key, tools }));
      } catch (error: unknown) {
        if (!live) return;
        console.warn('Could not load creation tools', error);
        cache.delete(key);
        setLast({ key, tools: NONE });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [account, key, local, model, sessionId]);

  if (local) return NONE;
  return cache.get(key) ?? (last?.key === key ? last.tools : null);
}

function sameTools(a: readonly CreationTool[], b: readonly CreationTool[]): boolean {
  return a.length === b.length && a.every((tool, i) => tool.name === b[i].name);
}

/** Test seam: the cache outlives a test's render. */
export function resetCreationToolsCache(): void {
  cache.clear();
}
