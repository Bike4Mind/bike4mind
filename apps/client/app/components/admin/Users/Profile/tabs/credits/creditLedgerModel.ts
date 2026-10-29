import type { AdminCreditSummary, AdminLedgerKind, AdminLedgerRow } from '@bike4mind/common';
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
