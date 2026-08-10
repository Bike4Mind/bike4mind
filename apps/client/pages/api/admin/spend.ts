import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, cacheRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { cacheService } from '@bike4mind/services';
import {
  CreditHolderType,
  type CostByModelRow,
  type DailyCostPoint,
  type ISpendSummary,
  type SpendByAccountRow,
  type SpendData,
  type SpendKpi,
} from '@bike4mind/common';
import { CacheKeys } from '@server/utils/cacheKeys';
import { ForbiddenError } from '@server/utils/errors';
import { resolveUserNames } from '@server/utils/resolveUserNames';
import { Request } from 'express';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

/** Guards org-id casts in the $in lookup from a BSONError 500 (see resolveUserNames). */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const QuerySchema = z
  .object({
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    userFilter: z.string().optional(),
    modelFilter: z.string().optional(),
    // Accepted for parity with the shared ModelMetrics filter bar but not applied:
    // UsageEvent statuses (ok|error|timeout|refusal) do not map to the quest statuses
    // this filter offers, and filtering here would distort the error/refusal KPIs.
    statusFilter: z.string().optional(),
    // Busts the server's 12h cache entry so a Refresh returns live data. Only the
    // literal "true" busts it (z.coerce.boolean would treat "false" as truthy).
    recache: z
      .string()
      .optional()
      .transform(v => v === 'true'),
  })
  .refine(
    q => {
      // Reject an inverted range up front; otherwise the prior window collapses to
      // zero length and every delta silently blanks with no signal to the caller.
      if (!q.dateFrom || !q.dateTo) return true;
      const from = new Date(q.dateFrom);
      const to = new Date(q.dateTo);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return true;
      return from.getTime() <= to.getTime();
    },
    { message: 'dateFrom must not be after dateTo', path: ['dateFrom'] }
  );

type SpendQuery = z.infer<typeof QuerySchema>;

/** Parse an ISO date, treating an unparseable value as absent rather than NaN. */
const parseDate = (value?: string): Date | undefined => {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const fmtDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Resolve the current window from the filter dates and derive the immediately
 * prior window of equal length (for the vs-prior KPI deltas). With no dates the
 * window defaults to the last 30 days.
 */
function resolveWindows(dateFrom?: string, dateTo?: string) {
  const now = new Date();
  const to = parseDate(dateTo) ?? now;
  const from = parseDate(dateFrom) ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  // Defensive floor: QuerySchema already rejects inverted ranges, so this stays >= 0.
  const windowMs = Math.max(to.getTime() - from.getTime(), 0);
  const priorTo = from;
  const priorFrom = new Date(from.getTime() - windowMs);
  const isDefault = !parseDate(dateFrom) && !parseDate(dateTo);

  return {
    current: { from, to },
    prior: { from: priorFrom, to: priorTo },
    periodLabel: isDefault ? `Last ${DEFAULT_WINDOW_DAYS} days` : `${fmtDay(from)} - ${fmtDay(to)}`,
    priorPeriodLabel: isDefault ? `Prior ${DEFAULT_WINDOW_DAYS} days` : `${fmtDay(priorFrom)} - ${fmtDay(priorTo)}`,
  };
}

const costPerRequest = (s: ISpendSummary): number => (s.totals.requests > 0 ? s.totals.cogsUsd / s.totals.requests : 0);

// Timeouts fold into the error rate (both are failed calls); refusals are their
// own rate. Refusals aren't recorded yet, so refusalRate reads 0 until they are.
const errorRate = (s: ISpendSummary): number =>
  s.status.total > 0 ? (s.status.errors + s.status.timeouts) / s.status.total : 0;

const refusalRate = (s: ISpendSummary): number => (s.status.total > 0 ? s.status.refusals / s.status.total : 0);

function buildKpis(current: ISpendSummary, prior: ISpendSummary): SpendKpi[] {
  return [
    {
      key: 'estCost',
      label: 'Est. Cost',
      value: current.totals.cogsUsd,
      priorValue: prior.totals.cogsUsd,
      format: 'currency',
      higherIsBetter: false,
    },
    {
      key: 'requests',
      label: 'Requests',
      value: current.totals.requests,
      priorValue: prior.totals.requests,
      format: 'number',
      higherIsBetter: true,
    },
    {
      key: 'costPerRequest',
      label: 'Cost / Req',
      value: costPerRequest(current),
      priorValue: costPerRequest(prior),
      format: 'currencyPrecise',
      higherIsBetter: false,
    },
    {
      key: 'creditsUsed',
      label: 'Credits Used',
      value: current.totals.creditsCharged,
      priorValue: prior.totals.creditsCharged,
      format: 'number',
      higherIsBetter: true,
    },
    {
      // Display card only (carries a vs-prior delta). The tab reads the top-level
      // SpendData.activeAccounts for truncation, not this KPI - keep them separate.
      key: 'activeAccounts',
      label: 'Active Accounts',
      value: current.activeAccounts,
      priorValue: prior.activeAccounts,
      format: 'number',
      higherIsBetter: true,
    },
    {
      key: 'p50Latency',
      label: 'p50 Latency',
      value: current.latency.p50,
      priorValue: prior.latency.p50,
      format: 'ms',
      higherIsBetter: false,
    },
    {
      key: 'p95Latency',
      label: 'p95 Latency',
      value: current.latency.p95,
      priorValue: prior.latency.p95,
      format: 'ms',
      higherIsBetter: false,
    },
    {
      key: 'errorRate',
      label: 'Error Rate',
      value: errorRate(current),
      priorValue: errorRate(prior),
      format: 'percent',
      higherIsBetter: false,
    },
    {
      key: 'refusalRate',
      label: 'Refusal Rate',
      value: refusalRate(current),
      priorValue: refusalRate(prior),
      format: 'percent',
      higherIsBetter: false,
    },
  ];
}

/** Resolve each account's ownerId to a display name (org name or user name), keyed by owner type. */
async function resolveAccountRows(current: ISpendSummary): Promise<SpendByAccountRow[]> {
  const accounts = current.byAccount;
  const userOwnerIds = accounts.filter(a => a.ownerType === CreditHolderType.User).map(a => a.ownerId);
  const orgOwnerIds = [
    ...new Set(accounts.filter(a => a.ownerType === CreditHolderType.Organization).map(a => a.ownerId)),
  ].filter(id => OBJECT_ID_RE.test(id));

  const [userNames, orgs] = await Promise.all([
    resolveUserNames(userOwnerIds),
    orgOwnerIds.length ? organizationRepository.find({ _id: { $in: orgOwnerIds } }) : Promise.resolve([]),
  ]);
  const orgNameById = new Map(orgs.map(o => [String(o.id), o.name]));

  return accounts.map(a => {
    const name = a.ownerType === CreditHolderType.Organization ? orgNameById.get(a.ownerId) : userNames.get(a.ownerId);
    return {
      accountId: a.ownerId,
      // Fall back to the raw id for unresolved owners (agent pools, legacy ids).
      accountName: name ?? a.ownerId,
      estCost: a.cogsUsd,
      requests: a.requests,
      creditsUsed: a.creditsCharged,
      costPerRequest: a.requests > 0 ? a.cogsUsd / a.requests : 0,
    };
  });
}

async function buildSpendData(query: Omit<SpendQuery, 'recache'>): Promise<SpendData> {
  const { current, prior, periodLabel, priorPeriodLabel } = resolveWindows(query.dateFrom, query.dateTo);
  const baseFilters = { userId: query.userFilter || undefined, model: query.modelFilter || undefined };

  const [currentSummary, priorSummary] = await Promise.all([
    usageEventRepository.spendSummary({ ...current, ...baseFilters }),
    usageEventRepository.spendSummary({ ...prior, ...baseFilters }),
  ]);

  const byAccount = await resolveAccountRows(currentSummary);

  const totalCogs = currentSummary.totals.cogsUsd;
  const byModel: CostByModelRow[] = currentSummary.byModel.map(m => ({
    // Key and label on provider+model: the same model id can be served by more than
    // one backend, so collapsing to model alone would merge rows and collide React
    // keys. Matches the sibling usage dashboard's `${provider} / ${model}` identity.
    modelId: `${m.provider}/${m.model}`,
    modelName: `${m.provider} / ${m.model}`,
    estCost: m.cogsUsd,
    requests: m.requests,
    share: totalCogs > 0 ? m.cogsUsd / totalCogs : 0,
  }));

  const dailyCost: DailyCostPoint[] = currentSummary.dailyCost.map(d => ({ date: d.day, cost: d.cogsUsd }));

  return {
    periodLabel,
    priorPeriodLabel,
    // "Some events were counted in this window" - requests is $sum:1 in spendSummary.
    hasData: currentSummary.totals.requests > 0,
    activeAccounts: currentSummary.activeAccounts,
    kpis: buildKpis(currentSummary, priorSummary),
    byAccount,
    byModel,
    dailyCost,
  };
}

/**
 * GET /api/admin/spend - real spend for the Model Metrics Spend tab, sourced from
 * the UsageEvent collection (frozen costUsd/creditsCharged/latencyMs). Computes the
 * selected window against the immediately prior window for vs-prior KPI deltas.
 * Admin-only; response cached 12h (bust with ?recache=true).
 */
const handler = baseApi().get(async (req: Request<{}, {}, {}, SpendQuery>, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { recache, ...query } = QuerySchema.parse(req.query);

  const cacheKey = CacheKeys.spend(query);
  const data = await cacheService.getCachedData(cacheKey, () => buildSpendData(query), {
    db: { caches: cacheRepository },
    expiry: 12 * 60 * 60 * 1000, // 12 hours
    recache,
    logger: req.logger,
  });

  return res.json(data);
});

export default handler;
