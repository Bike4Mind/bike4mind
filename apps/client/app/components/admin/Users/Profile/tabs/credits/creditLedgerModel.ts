import {
  COMPLETION_SOURCES,
  type AdminCreditSummary,
  type AdminLedgerFilter,
  type AdminLedgerKind,
  type AdminLedgerRow,
  type AdminSpendBucket,
  type CompletionSource,
} from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

export const SPEND_RANGES = ['7', '30', '90'] as const;
export type SpendRange = (typeof SPEND_RANGES)[number];

export const SPEND_RANGE_OPTIONS = SPEND_RANGES.map(range => ({ value: range, label: `${range}d` }));

export type LedgerFilter = AdminLedgerKind | 'all';

const KIND_DISPLAY: Readonly<Record<AdminLedgerKind, { label: string; filterLabel: string; tone: AdminStatusTone }>> = {
  usage: { label: 'Usage', filterLabel: 'Usage', tone: 'neutral' },
  api: { label: 'API', filterLabel: 'API', tone: 'info' },
  purchase: { label: 'Purchase', filterLabel: 'Purchases', tone: 'good' },
  subscription: { label: 'Renewal', filterLabel: 'Renewals', tone: 'good' },
  adjustment: { label: 'Adjustment', filterLabel: 'Adjustments', tone: 'warn' },
  transfer: { label: 'Transfer', filterLabel: 'Transfers', tone: 'neutral' },
};

export const LEDGER_FILTER_OPTIONS: readonly { value: LedgerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...(Object.keys(KIND_DISPLAY) as AdminLedgerKind[]).map(kind => ({
    value: kind,
    label: KIND_DISPLAY[kind].filterLabel,
  })),
];

/** The type chip: an adjustment made by an admin reads "Admin", like the prototype. */
export function ledgerTypeChip(row: AdminLedgerRow): { label: string; tone: AdminStatusTone } {
  const display = KIND_DISPLAY[row.kind];
  if (row.kind === 'adjustment' && row.actorId) return { label: 'Admin', tone: display.tone };
  return { label: display.label, tone: display.tone };
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  admin_adjustment: 'Admin adjustment',
  manual: 'Manual adjustment',
  credit_expiry: 'Credits expired',
  abuse_clawback: 'Abuse clawback',
};

const humanize = (value: string): string => {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const MIDDLE_DOT = ' · ';

/** One line saying what the row was: the admin's note and name, the key and tokens, or the description. */
export function ledgerRowDetail(row: AdminLedgerRow): string {
  const parts: string[] = [];
  if (row.kind === 'adjustment') {
    parts.push(row.note || (row.reason ? (REASON_LABELS[row.reason] ?? humanize(row.reason)) : row.description || ''));
    if (row.actorName) parts.push(`by ${row.actorName}`);
  } else {
    if (row.description) parts.push(row.description);
    if (row.apiKeyPrefix) parts.push(`key ${row.apiKeyPrefix}`);
    const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    if (tokens > 0) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  }
  return parts.filter(Boolean).join(MIDDLE_DOT);
}

/** The last `range` days of the summary's zero-filled 90-day series. */
export function spendWindow(daily: AdminCreditSummary['daily'], range: SpendRange): AdminCreditSummary['daily'] {
  return daily.slice(-Number(range));
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** `YYYY-MM-DD` (a UTC day) as "Oct 12". */
export function formatSpendDay(date: string): string {
  return DAY_FORMAT.format(new Date(`${date}T00:00:00Z`));
}

export const SPEND_VIEWS = ['day', 'model', 'source'] as const;
export type SpendView = (typeof SPEND_VIEWS)[number];

export const SPEND_VIEW_OPTIONS: readonly { value: SpendView; label: string }[] = [
  { value: 'day', label: 'By day' },
  { value: 'model', label: 'By model' },
  { value: 'source', label: 'By source' },
];

export const SOURCE_LABELS: Readonly<Record<CompletionSource, string>> = {
  web: 'Web',
  cli: 'CLI',
  desktop: 'Desktop',
  api: 'API',
  agent: 'Agent',
  system: 'System',
};

export const SOURCE_FILTER_OPTIONS: readonly { value: CompletionSource; label: string }[] = COMPLETION_SOURCES.map(
  source => ({ value: source, label: SOURCE_LABELS[source] })
);

export const isCompletionSource = (value: string): value is CompletionSource =>
  (COMPLETION_SOURCES as readonly string[]).includes(value);

/** The bars of one breakdown; past this many, the smallest fold into one "Other" bar. */
export const SPEND_BREAKDOWN_MAX_BARS = 8;

export type SpendBar = { label: string; credits: number };

const RANGE_FIELD: Readonly<Record<SpendRange, 'last7d' | 'last30d' | 'last90d'>> = {
  '7': 'last7d',
  '30': 'last30d',
  '90': 'last90d',
};

function bucketLabel(key: string | null, view: 'model' | 'source'): string {
  if (view === 'model') return key ?? 'Unknown model';
  if (key === null) return 'Unclassified';
  return isCompletionSource(key) ? SOURCE_LABELS[key] : key;
}

/** One range of a model or source breakdown, largest first, with the long tail folded into "Other". */
export function spendBreakdown(
  buckets: readonly AdminSpendBucket[],
  range: SpendRange,
  view: 'model' | 'source'
): SpendBar[] {
  const field = RANGE_FIELD[range];
  const bars = buckets
    .filter(bucket => bucket[field] > 0)
    .map(bucket => ({ label: bucketLabel(bucket.key, view), credits: bucket[field] }))
    .sort((a, b) => b.credits - a.credits || a.label.localeCompare(b.label));
  if (bars.length <= SPEND_BREAKDOWN_MAX_BARS) return bars;
  const kept = bars.slice(0, SPEND_BREAKDOWN_MAX_BARS - 1);
  const other = bars.slice(SPEND_BREAKDOWN_MAX_BARS - 1).reduce((sum, bar) => sum + bar.credits, 0);
  return [...kept, { label: 'Other', credits: other }];
}

/** What the ledger's filter row holds; empty strings and nulls mean "any". Dates are UTC YYYY-MM-DD. */
export type LedgerFilterState = {
  kind: LedgerFilter;
  model: string | null;
  source: CompletionSource | null;
  from: string;
  to: string;
};

export const EMPTY_LEDGER_FILTER: LedgerFilterState = { kind: 'all', model: null, source: null, from: '', to: '' };

export const isLedgerRangeInverted = ({ from, to }: LedgerFilterState): boolean => !!from && !!to && from > to;

export const hasLedgerFilter = (state: LedgerFilterState): boolean =>
  state.kind !== 'all' || !!state.model || !!state.source || !!state.from || !!state.to;

/** The wire filter (see adminLedgerFilterSchema), with unset fields left out. */
export function toLedgerQuery(state: LedgerFilterState): AdminLedgerFilter {
  const model = state.model?.trim();
  return {
    ...(state.kind !== 'all' && { kind: state.kind }),
    ...(model && { model }),
    ...(state.source && { source: state.source }),
    ...(state.from && { from: state.from }),
    ...(state.to && { to: state.to }),
  };
}
