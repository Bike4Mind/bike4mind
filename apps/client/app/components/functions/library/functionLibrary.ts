import type {
  CallableFunctionSharedStatus,
  CallableFunctionTrustLabel,
  ICallableFunctionPublic,
  ICallableFunctionShared,
} from '@bike4mind/common';

export type FunctionLibraryState = 'draft' | 'live' | 'off';

export type FunctionLibraryGroupKey = 'public' | 'mine' | 'shared';

/** A curated function anyone can call. No list returns one yet; the group renders only once one does. */
export type FunctionLibraryPublicEntry = Pick<
  ICallableFunctionShared,
  'id' | 'slug' | 'description' | 'trustLabel' | 'ownerName'
>;

export interface FunctionLibraryRow {
  id: string;
  slug: string;
  description: string;
  state: FunctionLibraryState;
  trustLabel: CallableFunctionTrustLabel | null;
  /** Shared and public rows. */
  ownerName?: string;
  /** Shared rows: this person's review of the function. */
  review?: CallableFunctionSharedStatus;
}

export interface FunctionLibraryGroup {
  key: FunctionLibraryGroupKey;
  title: string;
  /** The one line shown when the group has no rows. */
  empty: string;
  rows: FunctionLibraryRow[];
}

export interface FunctionLibraryLists {
  mine: ICallableFunctionPublic[];
  shared: ICallableFunctionShared[];
  public?: FunctionLibraryPublicEntry[];
}

const GROUPS: Record<FunctionLibraryGroupKey, { title: string; empty: string }> = {
  public: { title: 'Public', empty: 'No public functions yet.' },
  mine: { title: 'Mine', empty: "You have no functions yet. Make one from a Python artifact's Function tab." },
  shared: { title: 'Shared with me', empty: 'No one has shared a function with you.' },
};

const NO_MATCH = 'No functions here match your search.';

/** A deleted artifact leaves the function unable to run, so it reads as off like one turned off. */
const ownState = (status: ICallableFunctionPublic['status']): FunctionLibraryState =>
  status === 'live' || status === 'draft' ? status : 'off';

const mineRow = (fn: ICallableFunctionPublic): FunctionLibraryRow => ({
  id: fn.id,
  slug: fn.slug,
  description: fn.description,
  state: ownState(fn.status),
  trustLabel: fn.trustLabel,
});

const sharedRow = (fn: ICallableFunctionShared): FunctionLibraryRow => ({
  id: fn.id,
  slug: fn.slug,
  description: fn.description,
  state: fn.status === 'disabled' ? 'off' : 'live',
  trustLabel: fn.trustLabel,
  ownerName: fn.ownerName,
  review: fn.status,
});

const publicRow = (fn: FunctionLibraryPublicEntry): FunctionLibraryRow => ({
  id: fn.id,
  slug: fn.slug,
  description: fn.description,
  state: 'live',
  trustLabel: fn.trustLabel,
  ownerName: fn.ownerName,
});

/** Case-insensitive match on the name or the description; a blank search matches every row. */
export function matchesFunctionSearch(row: Pick<FunctionLibraryRow, 'slug' | 'description'>, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return row.slug.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle);
}

/** The library's groups in order: public (only when the lists carry one), mine, then shared with me. */
export function groupFunctionLibrary(lists: FunctionLibraryLists, search = ''): FunctionLibraryGroup[] {
  const searching = search.trim() !== '';
  const group = (key: FunctionLibraryGroupKey, rows: FunctionLibraryRow[]): FunctionLibraryGroup => ({
    key,
    title: GROUPS[key].title,
    empty: searching ? NO_MATCH : GROUPS[key].empty,
    rows: rows.filter(row => matchesFunctionSearch(row, search)),
  });
  return [
    ...(lists.public ? [group('public', lists.public.map(publicRow))] : []),
    group('mine', lists.mine.map(mineRow)),
    group('shared', lists.shared.map(sharedRow)),
  ];
}
