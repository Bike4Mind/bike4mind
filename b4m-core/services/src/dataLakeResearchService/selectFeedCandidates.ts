import type { ResearchFeedCursor, ResearchFeedFingerprintLevers, ResearchRunLevers } from '@bike4mind/common';
import {
  researchFeedFingerprint,
  researchFeedUrlKey,
  RESEARCH_FEED_DATE_GRACE_DAYS,
  RESEARCH_FEED_FUTURE_SKEW_MS,
  RESEARCH_FEED_SEEN_KEYS_MAX,
} from '@bike4mind/common';
import { canonicalSourceKey } from '../dataLakeService/canonicalSourceKey';
import type { ResearchCandidate } from './executeResearchRun';

const DAY_MS = 24 * 60 * 60 * 1000;

const earliestDate = (list: Keyed[]): Date | null => {
  const times = list.flatMap(entry => (entry.at === null ? [] : [entry.at]));
  return times.length ? new Date(Math.min(...times)) : null;
};

export type FeedSelectionLevers = ResearchFeedFingerprintLevers & Pick<ResearchRunLevers, 'maxResults'>;

export interface FeedSelection {
  /** In processing order. `publishedAt` is already clamped to `now` plus the skew allowance. */
  candidates: ResearchCandidate[];
  /**
   * First run only: keys of eligible items the run does not take. The caller records them as seen
   * so the next run does not walk back through the old feed. Oldest first, so trimming drops them first.
   */
  skipped: string[];
  /** Cursor runs only: eligible items not taken, left for the next run. */
  backlog: number;
  /**
   * Cursor runs only: the earliest clamped date among untaken items counted in `backlog`. The
   * cursor's floor must stay at or below it, or the date backstop could drop the item unjudged.
   */
  oldestWaitingAt: Date | null;
}

interface Keyed {
  candidate: ResearchCandidate;
  key: string;
  at: number | null;
}

export type FeedCursorMode = 'active' | 'same_feed' | 'fresh';

/**
 * How a stored cursor applies to the current levers: `active` on a fingerprint match, `same_feed`
 * when only levers other than the address changed, `fresh` when there is no usable cursor.
 */
export function feedCursorMode(
  cursor: ResearchFeedCursor | null | undefined,
  levers: FeedSelectionLevers
): FeedCursorMode {
  if (!cursor) return 'fresh';
  if (cursor.fingerprint === researchFeedFingerprint(levers)) return 'active';
  return cursor.feedUrlKey !== undefined && cursor.feedUrlKey === researchFeedUrlKey(levers.feedUrl)
    ? 'same_feed'
    : 'fresh';
}

/**
 * Picks which feed items this run judges. Pure.
 *
 * A cursor is fully honoured only when its fingerprint matches the current levers. When just the
 * settings changed, the newest items are re-checked and only the old cursor's seen items left over
 * are skipped, so unseen backlog stays eligible. Keys decide what is new; the date check is a
 * backstop that applies only once the key list has hit its cap and may have lost entries.
 */
export function selectFeedCandidates(
  items: readonly ResearchCandidate[],
  cursor: ResearchFeedCursor | null | undefined,
  levers: FeedSelectionLevers,
  now: Date
): FeedSelection {
  const mode = feedCursorMode(cursor, levers);
  const active = mode === 'active' ? cursor! : null;
  const seen = new Set(active?.seenKeys ?? []);
  const nowMs = now.getTime();
  const ceilingMs = nowMs + RESEARCH_FEED_FUTURE_SKEW_MS;
  const keysTrimmed = (active?.seenKeys.length ?? 0) >= RESEARCH_FEED_SEEN_KEYS_MAX;
  const backstopMs =
    keysTrimmed && active?.newestPublishedAt
      ? active.newestPublishedAt.getTime() - RESEARCH_FEED_DATE_GRACE_DAYS * DAY_MS
      : null;
  const recencyFloorMs = levers.recencyDays ? nowMs - levers.recencyDays * DAY_MS : null;

  const eligible: Keyed[] = [];
  const inFeed = new Set<string>();
  for (const item of items) {
    const key = canonicalSourceKey(item.url);
    if (!key || inFeed.has(key)) continue;
    inFeed.add(key);

    const at = item.publishedAt ? Math.min(item.publishedAt.getTime(), ceilingMs) : null;
    if (seen.has(key)) continue;
    if (at !== null && backstopMs !== null && at < backstopMs) continue;
    if (at !== null && recencyFloorMs !== null && at < recencyFloorMs) continue;
    eligible.push({ candidate: at === null ? item : { ...item, publishedAt: new Date(at) }, key, at });
  }

  const feedOrder = new Map(eligible.map((entry, index) => [entry, index]));
  const byFeedOrder = (a: Keyed, b: Keyed) => feedOrder.get(a)! - feedOrder.get(b)!;
  const oldestFirst = (list: Keyed[]): Keyed[] => [
    ...list.filter(entry => entry.at !== null).sort((a, b) => a.at! - b.at! || byFeedOrder(a, b)),
    ...list.filter(entry => entry.at === null).sort(byFeedOrder),
  ];

  if (active) {
    const attempts = new Map(active.retries.map(retry => [retry.key, retry.attempts]));
    const retried = (entry: Keyed) => (attempts.get(entry.key) ?? 0) > 0;
    // A poison item keeps its attempts but must not hold the front of the queue.
    const ordered = [
      ...oldestFirst(eligible.filter(entry => !retried(entry))),
      ...oldestFirst(eligible.filter(retried)),
    ];
    const taken = ordered.slice(0, levers.maxResults);
    const waiting = ordered.slice(levers.maxResults);
    return {
      candidates: taken.map(entry => entry.candidate),
      skipped: [],
      backlog: waiting.length,
      oldestWaitingAt: earliestDate(waiting),
    };
  }

  const newestFirst = [
    ...eligible.filter(entry => entry.at !== null).sort((a, b) => b.at! - a.at! || byFeedOrder(a, b)),
    ...eligible.filter(entry => entry.at === null).sort(byFeedOrder),
  ];
  const taken = newestFirst.slice(0, levers.maxResults);
  const rest = newestFirst.slice(levers.maxResults);
  if (mode === 'same_feed') {
    const previouslySeen = new Set(cursor!.seenKeys);
    const skipped = oldestFirst(rest.filter(entry => previouslySeen.has(entry.key)));
    const waiting = rest.filter(entry => !previouslySeen.has(entry.key));
    return {
      candidates: oldestFirst(taken).map(entry => entry.candidate),
      skipped: skipped.map(entry => entry.key),
      backlog: waiting.length,
      oldestWaitingAt: earliestDate(waiting),
    };
  }
  return {
    candidates: oldestFirst(taken).map(entry => entry.candidate),
    skipped: oldestFirst(rest).map(entry => entry.key),
    backlog: 0,
    oldestWaitingAt: null,
  };
}
