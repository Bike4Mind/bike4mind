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
 * region's, which already leaves out the scrollbar the column is centred beside. Not until it has
 * been measured: a rail drawn on a guess would cover the text in a window that turns out narrow.
 */
export function railFitsBesideThread(regionWidth: number | null): boolean {
  if (regionWidth === null) return false;
  const freeOnLeft = (regionWidth - CONTENT_MAX_WIDTH) / 2 + COLUMN_PADDING;
  return freeOnLeft >= REPLY_STATS_RAIL_WIDTH + 2 * REPLY_STATS_RAIL_INSET;
}

/**
 * Per-machine window chrome in localStorage, with subscribers, as tokenRate.ts kept the switch
 * these replace: the header toggle, Settings and every reply read them.
 */
const RAIL_KEY = 'b4m.chat.replyStats.rail';
/** The stats the user ticked or unticked, as {id: shown}; the rest keep their default. */
const CHOICES_KEY = 'b4m.chat.replyStats.shown';
/** The old tok/s switch; off there carries over as the speed stat unticked. */
const LEGACY_RATE_KEY = 'b4m.chat.showTokenRate';

/**
 * Off until ticked: a self-hosted server's own timings and the wait for the first token. Each is
 * a row on every reply, and a reply is held tall enough for all of its rows.
 */
export const REPLY_STATS_OFF_BY_DEFAULT: ReadonlySet<ReplyStatId> = new Set([
  'promptSpeed',
  'firstToken',
  'load',
  'draft',
]);

export interface ReplyStatsPrefs {
  /** The rail beside the conversation, wherever it fits. */
  rail: boolean;
  /** Stats not shown: the ones unticked, and the ones off by default that were never ticked. */
  hidden: ReadonlySet<ReplyStatId>;
}

type ReplyStatChoices = Partial<Record<ReplyStatId, boolean>>;

/** Rail on and each stat at its default unless stored otherwise; anything unreadable reads as the default. */
export function parseReplyStatsPrefs(
  rail: string | null,
  choices: string | null,
  legacyRate: string | null
): ReplyStatsPrefs {
  return { rail: rail !== '0', hidden: hiddenBy(parseChoices(choices, legacyRate)) };
}

function parseChoices(raw: string | null, legacyRate: string | null): ReplyStatChoices {
  if (raw === null) return legacyRate === '0' ? { speed: false } : {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const choices: ReplyStatChoices = {};
    for (const [id, shown] of Object.entries(parsed)) {
      if (isReplyStatId(id) && typeof shown === 'boolean') choices[id] = shown;
    }
    return choices;
  } catch {
    return {};
  }
}

function hiddenBy(choices: ReplyStatChoices): ReadonlySet<ReplyStatId> {
  return new Set(REPLY_STATS.filter(id => !(choices[id] ?? !REPLY_STATS_OFF_BY_DEFAULT.has(id))));
}

let choices: ReplyStatChoices = {};
let prefs = readStored();
const listeners = new Set<() => void>();

function readStored(): ReplyStatsPrefs {
  let rail: string | null = null;
  let stored: string | null = null;
  let legacyRate: string | null = null;
  try {
    const storage = window.localStorage;
    rail = storage.getItem(RAIL_KEY);
    stored = storage.getItem(CHOICES_KEY);
    legacyRate = storage.getItem(LEGACY_RATE_KEY);
  } catch {
    // Unreadable storage reads as the defaults.
  }
  choices = parseChoices(stored, legacyRate);
  return { rail: rail !== '0', hidden: hiddenBy(choices) };
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
  const next: ReplyStatChoices = { ...choices };
  // Back at its default it is no choice at all, so a later change of default reaches it.
  if (shown === !REPLY_STATS_OFF_BY_DEFAULT.has(id)) delete next[id];
  else next[id] = shown;
  choices = next;
  publish({ ...prefs, hidden: hiddenBy(next) }, CHOICES_KEY, JSON.stringify(next));
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

/** Re-read storage, as a fresh launch would; also the test seam. */
export function reloadReplyStatsPrefs(): void {
  prefs = readStored();
  for (const listener of listeners) listener();
}

// Another window's change reaches this one's storage, but only this event says it did. A null key is a clear().
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === RAIL_KEY || event.key === CHOICES_KEY || event.key === LEGACY_RATE_KEY) {
      reloadReplyStatsPrefs();
    }
  });
}
