import type { ChatArtifactSummary } from '@shared/chat';
import { TYPE_LABEL } from './ArtifactCard';

export type ArtifactSort = 'newest' | 'oldest' | 'title';

export const ARTIFACT_SORTS: { value: ArtifactSort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title A-Z' },
];

/**
 * A summary with everything search and sort compare precomputed once per load, so a keystroke
 * costs one substring test per row rather than a lowercase and a date parse per comparison.
 */
export interface IndexedArtifact {
  summary: ChatArtifactSummary;
  /** Epoch ms; NaN for a missing or unparseable timestamp, which sorts last either way. */
  time: number;
  haystack: string;
}

export interface ArtifactTypeCount {
  type: string;
  label: string;
  count: number;
}

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

export function indexArtifacts(summaries: readonly ChatArtifactSummary[]): IndexedArtifact[] {
  return summaries.map(summary => ({
    summary,
    time: Date.parse(summary.createdAt),
    haystack: `${summary.title}\n${summary.description ?? ''}`.toLowerCase(),
  }));
}

/** Counts over the whole loaded list, so a chip still says how many there are once selected. */
export function countTypes(rows: readonly IndexedArtifact[]): ArtifactTypeCount[] {
  const counts = new Map<string, number>();
  for (const { summary } of rows) counts.set(summary.type, (counts.get(summary.type) ?? 0) + 1);
  return [...counts]
    .map(([type, count]) => ({ type, label: typeLabel(type), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function byTime(direction: 1 | -1) {
  return (a: IndexedArtifact, b: IndexedArtifact): number => {
    const aMissing = Number.isNaN(a.time);
    const bMissing = Number.isNaN(b.time);
    if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
    return (a.time - b.time) * direction;
  };
}

export function selectArtifacts(
  rows: readonly IndexedArtifact[],
  { query, type, sort }: { query: string; type: string | null; sort: ArtifactSort }
): ChatArtifactSummary[] {
  const needle = query.trim().toLowerCase();
  const matched = rows.filter(
    row => (type === null || row.summary.type === type) && (!needle || row.haystack.includes(needle))
  );
  matched.sort(
    sort === 'title'
      ? (a, b) => titleCollator.compare(a.summary.title, b.summary.title)
      : byTime(sort === 'newest' ? -1 : 1)
  );
  return matched.map(row => row.summary);
}

/** Compact date for the row: same-year dates drop the year, as the web app's artifact list does. */
export function shortDate(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** FNV-1a: spreads short, similar ids far apart where a character sum would cluster them. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const AVATAR_HUES = 24;

/**
 * The avatar's fill and letter colour. Keyed on the id, not the title, so renaming an artifact on
 * the web does not recolour its row. Each mode gets its own lightness pair - a pale tint with a
 * dark letter in light mode, a deep tint with a pale letter in dark - so the initial keeps its
 * contrast whichever hue comes up.
 */
export function avatarColors(id: string, mode: 'light' | 'dark'): { background: string; color: string } {
  const hue = (hash32(id) % AVATAR_HUES) * (360 / AVATAR_HUES);
  return mode === 'dark'
    ? { background: `hsl(${hue} 38% 28%)`, color: `hsl(${hue} 80% 88%)` }
    : { background: `hsl(${hue} 72% 90%)`, color: `hsl(${hue} 58% 28%)` };
}

export function initialOf(title: string): string {
  const first = title.trim().codePointAt(0);
  return first === undefined ? '?' : String.fromCodePoint(first).toUpperCase();
}
