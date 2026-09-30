import { z } from 'zod';
import { QA_SLUG_PATTERN } from '@bike4mind/common';

/** Twin of QaStatusSearch in app/hooks/data/qaStatus.ts. */
export interface QaFilters {
  product: string;
  tenant?: string;
  env?: string;
  branch: string;
  rangeDays: 7 | 30;
}

// The page's "All" option sends ''.
const optionalSelect = z
  .string()
  .max(255)
  .optional()
  .transform(v => (v ? v : undefined));

const QaFiltersQuerySchema = z.object({
  product: z.string().regex(QA_SLUG_PATTERN),
  tenant: optionalSelect,
  env: optionalSelect,
  branch: z.string().min(1).max(255).default('main'),
  range: z.enum(['7d', '30d']).default('7d'),
});

/** Admin query string to filters. Throws ZodError (422) on bad input. */
export function parseQaFilters(query: Record<string, unknown>): QaFilters {
  const q = QaFiltersQuerySchema.parse(query);
  const filters: QaFilters = { product: q.product, branch: q.branch, rangeDays: q.range === '30d' ? 30 : 7 };
  if (q.tenant) filters.tenant = q.tenant;
  if (q.env) filters.env = q.env;
  return filters;
}
