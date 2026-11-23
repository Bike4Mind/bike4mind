import {
  SPEND_AUDIENCES,
  SPEND_FEATURE_ID_PATTERN,
  SPEND_SPLIT_DIMENSIONS,
  type SpendAudience,
  type SpendSplitDimension,
} from '@bike4mind/common';
import { customRange, DEFAULT_PRESET, presetRange, RANGE_PRESETS, type SpendRange } from './spendExplorerModel';

export const ADMIN_SPEND_EXPLORER_TAB_SLUG = 'spend-explorer';

/**
 * URL keys the Spend explorer owns (registered in adminTabParams.ts). The range and
 * the selected bucket live in the URL so a link can open the page on one hour.
 */
export const SPEND_EXPLORER_SEARCH_KEYS = {
  range: 'spendRange',
  from: 'spendFrom',
  to: 'spendTo',
  split: 'spendSplit',
  at: 'spendAt',
  previous: 'spendPrevious',
  audience: 'spendAudience',
  feature: 'spendFeature',
  user: 'spendUser',
} as const;
export const SPEND_EXPLORER_TAB_PARAMS = Object.values(SPEND_EXPLORER_SEARCH_KEYS);

type SpendExplorerKey = (typeof SPEND_EXPLORER_TAB_PARAMS)[number];
/** What the page writes: the admin route declares every tab param as a string. */
export type SpendExplorerSearchPatch = Partial<Record<SpendExplorerKey, string | undefined>>;
// The router JSON-parses search values, so a hand-edited `spendRange=30` arrives as a number.
export type SpendExplorerSearch = Partial<Record<SpendExplorerKey, unknown>>;

export type SpendExplorerView = {
  /** A preset in days, or 'custom' for spendFrom/spendTo. */
  preset: number | 'custom';
  range: SpendRange;
  split: SpendSplitDimension;
  /** Selected bucket start (ISO), or null for the whole range. */
  at: string | null;
  showPrevious: boolean;
  /** Whose usage the feature table counts. */
  audience: SpendAudience;
  /** Feature whose top users are open, or null. */
  feature: string | null;
  /** Acting user whose feature mix is open, or null. */
  user: string | null;
};

const isAudience = (value: unknown): value is SpendAudience =>
  typeof value === 'string' && (SPEND_AUDIENCES as readonly string[]).includes(value);

const matchOrNull =
  (pattern: RegExp) =>
  (value: unknown): string | null =>
    typeof value === 'string' && pattern.test(value) ? value : null;

const userIdOrNull = matchOrNull(/^[A-Za-z0-9_-]{1,64}$/);
// The server's own rule, so a hand-edited link falls back to the feature list rather than an error.
const featureOrNull = matchOrNull(SPEND_FEATURE_ID_PATTERN);

const isSplit = (value: unknown): value is SpendSplitDimension =>
  typeof value === 'string' && (SPEND_SPLIT_DIMENSIONS as readonly string[]).includes(value);

/** Read the view from the URL, falling back to the default preset for anything malformed. */
export function readSpendExplorerSearch(search: SpendExplorerSearch, now: Date = new Date()): SpendExplorerView {
  const keys = SPEND_EXPLORER_SEARCH_KEYS;
  const splitRaw = search[keys.split];
  const split = isSplit(splitRaw) ? splitRaw : 'provider';
  const atRaw = search[keys.at];
  const at =
    typeof atRaw === 'string' && !Number.isNaN(new Date(atRaw).getTime()) ? new Date(atRaw).toISOString() : null;
  const previous = search[keys.previous];
  const showPrevious = previous === true || previous === 'true' || previous === 1 || previous === '1';
  const audienceRaw = search[keys.audience];
  const featureView = {
    audience: isAudience(audienceRaw) ? audienceRaw : 'all',
    feature: featureOrNull(search[keys.feature]),
    user: userIdOrNull(search[keys.user]),
  } as const;

  const fromRaw = search[keys.from];
  const toRaw = search[keys.to];
  const custom =
    search[keys.range] === 'custom' && typeof fromRaw === 'string' && typeof toRaw === 'string'
      ? customRange(fromRaw, toRaw)
      : null;
  if (custom) return { preset: 'custom', range: custom, split, at, showPrevious, ...featureView };

  const days = Number(search[keys.range]);
  const preset = (RANGE_PRESETS as readonly number[]).includes(days) ? days : DEFAULT_PRESET;
  return { preset, range: presetRange(preset, now), split, at, showPrevious, ...featureView };
}
