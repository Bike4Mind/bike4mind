import type { ChatSessionSummary } from '@shared/chat';
import type { ContextSelection } from './types';

export function selectSessions(
  current: string,
  selection: ContextSelection,
  candidates: readonly Pick<ChatSessionSummary, 'id' | 'origin'>[],
  limit: number
): { ids: string[]; truncated: boolean } {
  if (selection.kind === 'current') return { ids: [current], truncated: false };
  if (selection.kind === 'explicit') {
    const unique = [...new Set(selection.sessionIds)];
    return { ids: unique.slice(0, limit), truncated: unique.length > limit };
  }
  const family = new Set([current]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      const parent = candidate.origin?.parentSessionId;
      if (!parent || (!family.has(candidate.id) && !family.has(parent))) continue;
      for (const id of [candidate.id, parent]) {
        if (family.has(id)) continue;
        family.add(id);
        changed = true;
      }
    }
  }
  return { ids: [...family].slice(0, limit), truncated: family.size > limit };
}
