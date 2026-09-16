import { isOptimisticId } from './llm';

/** The shape of the `['quests', 'session', <id>]` infinite-query cache (see useGetSessionQuests). */
export interface CachedQuestPages {
  pages: Array<{ data: Array<{ id?: string }> }>;
}

/**
 * Newest real quest id across the cached pages of a session.
 *
 * Quest ids are Mongo ObjectIds (monotonic hex), so a lexical max is the latest turn
 * independent of how the pages happen to be sorted. Optimistic client-generated ids are
 * skipped: the server cannot resolve them, and claiming one only gets it dropped.
 */
export function latestQuestId(cache: CachedQuestPages | undefined): string | undefined {
  let latest: string | undefined;
  for (const page of cache?.pages ?? []) {
    for (const quest of page.data) {
      if (!quest.id || isOptimisticId(quest.id)) continue;
      if (!latest || quest.id > latest) latest = quest.id;
    }
  }
  return latest;
}
