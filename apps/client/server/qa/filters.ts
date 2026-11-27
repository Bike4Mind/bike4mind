import { z } from 'zod';
import { QA_SLUG_PATTERN } from '@bike4mind/common';

/** Twin of QaStatusSearch in app/hooks/data/qaStatus.ts. */
export interface QaFilters {
  product: string;
  tenant?: string;
  env?: string;
  branch: string;
  /** Runs started at or after `from` and before `to`. */
  from: Date;
  to: Date;
}

const DAY_MS = 86_400_000;
/** Widest range the page can ask for; the chart and flaky reads are capped by run count too. */
export const QA_MAX_RANGE_DAYS = 366;
// Instants lose the viewer's timezone; allow offset transitions while keeping scans below 367 elapsed days.
const MAX_RANGE_ELAPSED_MS = (QA_MAX_RANGE_DAYS + 1) * DAY_MS;

// The page's "All" option sends ''.
const optionalSelect = z
  .string()
  .max(255)
  .optional()
  .transform(v => (v ? v : undefined));

const QaFiltersQueryObject = z.object({
  product: z.string().regex(QA_SLUG_PATTERN),
  tenant: optionalSelect,
  env: optionalSelect,
  branch: z.string().min(1).max(255).default('main'),
  // The page sends local-day bounds as instants, so "Today" means the viewer's day.
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  // Older links: a rolling window ending now. Ignored when from/to are given.
  range: z.enum(['7d', '30d']).default('7d'),
});

// Refined after any .omit(): zod refuses to omit keys from a refined object.
function withRangeChecks<S extends z.ZodType<{ from?: string; to?: string }>>(schema: S) {
  return schema
    .refine(q => (q.from === undefined) === (q.to === undefined), { message: 'from and to go together' })
    .refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to' })
    .refine(q => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) < MAX_RANGE_ELAPSED_MS, {
      message: `range is at most ${QA_MAX_RANGE_DAYS} days`,
    });
}

const QaFiltersQuerySchema = withRangeChecks(QaFiltersQueryObject);

/** from/to as given, else the legacy rolling `range` ending at `now`. */
function rangeBounds(q: { from?: string; to?: string; range: '7d' | '30d' }, now: Date): { from: Date; to: Date } {
  const days = q.range === '30d' ? 30 : 7;
  return {
    from: q.from ? new Date(q.from) : new Date(now.getTime() - days * DAY_MS),
    to: q.to ? new Date(q.to) : now,
  };
}

/** The summary spans every product, so it takes no product or tenant. */
export type QaSummaryFilters = Omit<QaFilters, 'product' | 'tenant'>;

const QaSummaryQuerySchema = withRangeChecks(QaFiltersQueryObject.omit({ product: true, tenant: true }));

/** Admin query string to summary filters. Ignores product/tenant; throws ZodError (422) on bad input. */
export function parseQaSummaryFilters(query: Record<string, unknown>, now: Date = new Date()): QaSummaryFilters {
  const q = QaSummaryQuerySchema.parse(query);
  const filters: QaSummaryFilters = { branch: q.branch, ...rangeBounds(q, now) };
  if (q.env) filters.env = q.env;
  return filters;
}

/** Admin query string to filters. Throws ZodError (422) on bad input. */
export function parseQaFilters(query: Record<string, unknown>, now: Date = new Date()): QaFilters {
  const q = QaFiltersQuerySchema.parse(query);
  const filters: QaFilters = { product: q.product, branch: q.branch, ...rangeBounds(q, now) };
  if (q.tenant) filters.tenant = q.tenant;
  if (q.env) filters.env = q.env;
  return filters;
}
