import type { LibraryItem, LibraryMedium, LibraryPage } from '@shared/library';

/**
 * Images and videos are two server lists, each newest first with its own cursor. "All" shows
 * them merged, which is only safe down to the point both lists have reached: an image older than
 * the oldest video loaded so far could still have a newer video waiting on the next video page.
 * So the merged view stops at the newest of the two "oldest loaded" timestamps, and "Load more"
 * fetches the list that sets that limit.
 */
export type LibraryFilter = 'all' | LibraryMedium;

export interface StreamState {
  items: LibraryItem[];
  /** Undefined until the first page; null once the list is exhausted. */
  cursor: string | null | undefined;
}

export type FeedState = Record<LibraryMedium, StreamState>;

export const MEDIA: readonly LibraryMedium[] = ['image', 'video'];

export const emptyFeed = (): FeedState => ({
  image: { items: [], cursor: undefined },
  video: { items: [], cursor: undefined },
});

const started = (stream: StreamState) => stream.cursor !== undefined;
const exhausted = (stream: StreamState) => stream.cursor === null;
const time = (item: LibraryItem) => Date.parse(item.createdAt);

const mediaOf = (filter: LibraryFilter): readonly LibraryMedium[] => (filter === 'all' ? MEDIA : [filter]);

export function appendPage(state: FeedState, medium: LibraryMedium, page: LibraryPage): FeedState {
  const seen = new Set(state[medium].items.map(item => item.id));
  const items = [...state[medium].items, ...page.items.filter(item => !seen.has(item.id))];
  return { ...state, [medium]: { items, cursor: page.nextCursor } };
}

/** The oldest timestamp the merged view may show, or null when nothing limits it. */
function cutoff(state: FeedState, media: readonly LibraryMedium[]): number | null {
  let limit: number | null = null;
  for (const medium of media) {
    const stream = state[medium];
    if (exhausted(stream)) continue;
    const last = stream.items[stream.items.length - 1];
    // A list that has not loaded, or loaded nothing yet but has more, limits everything.
    if (!last) return Number.POSITIVE_INFINITY;
    const oldest = time(last);
    if (limit === null || oldest > limit) limit = oldest;
  }
  return limit;
}

/** What the filter shows now, newest first. */
export function visibleItems(state: FeedState, filter: LibraryFilter): LibraryItem[] {
  const media = mediaOf(filter);
  if (media.length === 1) return state[media[0]].items;
  const limit = cutoff(state, media);
  return media
    .flatMap(medium => state[medium].items)
    .filter(item => limit === null || time(item) >= limit)
    .sort((a, b) => time(b) - time(a) || b.id.localeCompare(a.id));
}

/** The lists the next load should fetch: none when everything the filter covers is shown. */
export function nextToLoad(state: FeedState, filter: LibraryFilter): LibraryMedium[] {
  const media = mediaOf(filter);
  const unstarted = media.filter(medium => !started(state[medium]));
  if (unstarted.length > 0) return unstarted;
  const open = media.filter(medium => !exhausted(state[medium]));
  if (open.length <= 1) return open;
  // The list whose oldest loaded item is newest is the one holding the merged view back.
  const limit = cutoff(state, media);
  return open.filter(medium => {
    const last = state[medium].items[state[medium].items.length - 1];
    return !last || time(last) === limit;
  });
}

export const needsFirstLoad = (state: FeedState, filter: LibraryFilter) =>
  mediaOf(filter).some(medium => !started(state[medium]));
