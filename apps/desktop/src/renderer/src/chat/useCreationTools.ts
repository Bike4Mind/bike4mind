import { useEffect, useState } from 'react';
import type { CreationTool } from '@shared/chat';

// Module-level so a second blank chat draws its cards on the first frame instead of after a round trip.
let cache: { account: string; tools: CreationTool[] } | null = null;

/**
 * The generation tools a Chat turn would be offered, or null until main has answered once for this
 * account. Asked again on each new blank chat (`refreshKey`), never on render: main answers from the
 * same short cache the next turn reads, and the last answer stays on screen while it does.
 */
export function useCreationTools(account: string, refreshKey: string | null): CreationTool[] | null {
  const [tools, setTools] = useState<CreationTool[] | null>(() => (cache?.account === account ? cache.tools : null));

  useEffect(() => {
    if (cache?.account !== account) setTools(null);
    if (refreshKey === null) return;
    let live = true;
    window.b4m.chat
      .listCreationTools()
      .then(next => {
        cache = { account, tools: next };
        if (live) setTools(current => (sameTools(current, next) ? current : next));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account, refreshKey]);

  return tools;
}

function sameTools(a: readonly CreationTool[] | null, b: readonly CreationTool[]): boolean {
  return (
    !!a &&
    a.length === b.length &&
    a.every((tool, i) => tool.name === b[i].name && tool.spendsCredits === b[i].spendsCredits)
  );
}

/** Test seam: the cache outlives a test's render. */
export function resetCreationToolsCache(): void {
  cache = null;
}
