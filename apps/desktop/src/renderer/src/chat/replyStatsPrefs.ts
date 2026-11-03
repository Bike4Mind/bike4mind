import { useSyncExternalStore } from 'react';
import { COLUMN_PADDING, CONTENT_MAX_WIDTH } from './layout';
import { isReplyStatId, REPLY_STATS, type ReplyStatId } from './replyStats';

/** The stats rail's width, in px. */
export const REPLY_STATS_RAIL_WIDTH = 200;
/**
 * Gap between the rail and the reply's text, and between the rail and the pane's edge, in px.
 * Wider than the text's own spacing, so a rail value never reads as the start of the reply's line.
 */
export const REPLY_STATS_RAIL_INSET = 16;

/**
 * Whether the stats rail fits left of the reading column without covering its text; the left-hand
 * counterpart of panelFitsBesideThread, read off the same measured width. That width is the thread
 * region's, which already leaves out the scrollbar the column is centred beside.
 */
export function railFitsBesideThread(regionWidth: number): boolean {
  const freeOnLeft = (regionWidth - CONTENT_MAX_WIDTH) / 2 + COLUMN_PADDING;
  return freeOnLeft >= REPLY_STATS_RAIL_WIDTH + 2 * REPLY_STATS_RAIL_INSET;
}

/**
 * Per-machine window chrome in localStorage, with subscribers, as tokenRate.ts kept the switch
 * these replace: the header toggle, Settings and every reply read them.
 */
const RAIL_KEY = 'b4m.chat.replyStats.rail';
const HIDDEN_KEY = 'b4m.chat.replyStats.hidden';
/** The old tok/s switch; off there carries over as the speed stat unticked. */
const LEGACY_RATE_KEY = 'b4m.chat.showTokenRate';

export interface ReplyStatsPrefs {
  /** The rail beside the conversation, wherever it fits. */
  rail: boolean;
  /** Stats the user unticked. Hidden rather than shown is kept, so a stat added later starts on. */
  hidden: ReadonlySet<ReplyStatId>;
}

/** Rail on and every stat shown unless stored otherwise; anything unreadable reads as the default. */
export function parseReplyStatsPrefs(
  rail: string | null,
  hidden: string | null,
  legacyRate: string | null
): ReplyStatsPrefs {
  return { rail: rail !== '0', hidden: parseHidden(hidden, legacyRate) };
}

function parseHidden(raw: string | null, legacyRate: string | null): ReadonlySet<ReplyStatId> {
  if (raw === null) return new Set<ReplyStatId>(legacyRate === '0' ? ['speed'] : []);
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(isReplyStatId) : []);
  } catch {
    return new Set();
  }
}

let prefs = readStored();
const listeners = new Set<() => void>();

function readStored(): ReplyStatsPrefs {
  try {
    const storage = window.localStorage;
    return parseReplyStatsPrefs(
      storage.getItem(RAIL_KEY),
      storage.getItem(HIDDEN_KEY),
      storage.getItem(LEGACY_RATE_KEY)
    );
  } catch {
    return parseReplyStatsPrefs(null, null, null);
  }
}

function publish(next: ReplyStatsPrefs, key: string, value: string): void {
  prefs = next;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a click.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function current(): ReplyStatsPrefs {
  return prefs;
}

export function setReplyStatsRail(rail: boolean): void {
  if (rail === prefs.rail) return;
  publish({ ...prefs, rail }, RAIL_KEY, rail ? '1' : '0');
}

export function setReplyStatShown(id: ReplyStatId, shown: boolean): void {
  if (shown !== prefs.hidden.has(id)) return;
  const hidden = new Set(prefs.hidden);
  if (shown) hidden.delete(id);
  else hidden.add(id);
  publish({ ...prefs, hidden }, HIDDEN_KEY, JSON.stringify(REPLY_STATS.filter(stat => hidden.has(stat))));
}

export function useReplyStatsPrefs(): ReplyStatsPrefs {
  return useSyncExternalStore(subscribe, current, current);
}

export function useReplyStatShown(id: ReplyStatId): boolean {
  return !useReplyStatsPrefs().hidden.has(id);
}

/** Settings' one-line summary of both. */
export function replyStatsSummary({ rail, hidden }: ReplyStatsPrefs): string {
  const shown = REPLY_STATS.length - hidden.size;
  const which =
    shown === REPLY_STATS.length ? 'All stats' : shown === 0 ? 'No stats' : `${shown} of ${REPLY_STATS.length} stats`;
  return `${which}, ${rail ? 'beside the conversation when the window is wide enough' : 'under each reply on hover'}`;
}

/** Test seam: re-read storage, as a fresh launch would. */
export function reloadReplyStatsPrefs(): void {
  prefs = readStored();
  for (const listener of listeners) listener();
}
