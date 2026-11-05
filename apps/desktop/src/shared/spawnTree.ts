import type { ChatSessionSummary } from './chat';

/**
 * Distance from `rootId` up the parent chain, or null if the chain ends elsewhere, loops, or passes
 * through an archived session below the root (archiving an agent shelves its whole subtree).
 */
function depthBelow(
  session: ChatSessionSummary,
  rootId: string,
  byId: ReadonlyMap<string, ChatSessionSummary>
): number | null {
  const visited = new Set<string>([session.id]);
  let depth = 0;
  let current: ChatSessionSummary | undefined = session;
  while (current?.origin) {
    depth += 1;
    const parentId: string = current.origin.parentSessionId;
    if (parentId === rootId) return depth;
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    current = byId.get(parentId);
    if (current?.archived) return null;
  }
  return null;
}

export type SpawnedSession = ChatSessionSummary & Required<Pick<ChatSessionSummary, 'origin'>>;

const isSpawned = (session: ChatSessionSummary): session is SpawnedSession => session.origin !== undefined;

/** Every live session below `rootId`, with its depth. Shared by the roster and the needs-you rules. */
export function descendantsOf(
  sessions: readonly ChatSessionSummary[],
  rootId: string
): Array<{ session: SpawnedSession; depth: number }> {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const found: Array<{ session: SpawnedSession; depth: number }> = [];
  for (const session of sessions) {
    if (session.archived || !isSpawned(session) || session.id === rootId) continue;
    const depth = depthBelow(session, rootId, byId);
    if (depth !== null) found.push({ session, depth });
  }
  return found;
}
