import {
  AgentExecutionModel,
  ApiKeyUsageLog,
  Quest,
  SideAppRefusal,
  SideAppRefusalCounter,
  oauthClientRepository,
} from '@bike4mind/database';
import { emptyOutcomeCounts, type OutcomeCounts, type StatusClass } from '@bike4mind/server-utils/sideApps/outcomes';
import {
  type SideAppDailyCredits,
  type SideAppEndpointRequests,
  type SideAppFailureCode,
  type SideAppRefusalSummary,
  type SideAppRow,
  type SideAppsResponse,
  type SideAppTierCredits,
} from '../../../shared/sideApps';
import {
  MAX_TIME_MS,
  addOutcome,
  addRefusal,
  agentOutcomeOf,
  aggregateSpend,
  chargeMatch,
  emptyRefusals,
  emptyTierCredits,
  emptyTierRequests,
  findAttributionStartedAt,
  foldRequestRow,
  questOutcomeOf,
  resolveUnstampedExchangeKeys,
  resolveWindows,
  sortRefusalReasons,
  statusClassExpression,
  summarizeOutcomes,
  unstampedKeyMatch,
  type SpendCell,
  type SpendUser,
} from './shared';

interface AppAccumulator {
  tiers: SideAppTierCredits;
  daily: Map<string, number>;
  users: Set<string>;
  requests: {
    total: number;
    byTier: ReturnType<typeof emptyTierRequests>;
    endpoints: Map<string, SideAppEndpointRequests>;
  };
  outcomes: OutcomeCounts;
  failureCodes: Map<string, number>;
  refusals: SideAppRefusalSummary;
}

const newAccumulator = (): AppAccumulator => ({
  tiers: emptyTierCredits(),
  daily: new Map(),
  users: new Set(),
  requests: { total: 0, byTier: emptyTierRequests(), endpoints: new Map() },
  outcomes: emptyOutcomeCounts(),
  failureCodes: new Map(),
  refusals: emptyRefusals(),
});

const TOP_FAILURE_CODES = 5;

const topFailureCodes = (codes: Map<string, number>): SideAppFailureCode[] =>
  [...codes.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, TOP_FAILURE_CODES);

const dailySeries = (daily: Map<string, number>): SideAppDailyCredits[] =>
  [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, credits]) => ({ day, credits }));

const sumTiers = (tiers: SideAppTierCredits) => tiers.paid + tiers.unpaid + tiers.org + tiers.unrecorded;

interface GroupedCount<K> {
  _id: K;
  count: number;
}

export async function readSideApps(days: number, now: Date = new Date()): Promise<SideAppsResponse> {
  const windows = resolveWindows(days, now);
  const unstampedKeys = await resolveUnstampedExchangeKeys(windows.legacyFrom);
  const unstampedKeyIds = [...unstampedKeys.keys()];

  const [stamped, unstamped, usageRows, questRows, agentRows, refusalRows, counterRows, attributionStartedAt] =
    await Promise.all([
      aggregateSpend({ oauthClientId: { $exists: true }, ...chargeMatch(windows.spendFrom) }, 'oauthClientId'),
      unstampedKeyIds.length
        ? aggregateSpend(unstampedKeyMatch(windows.legacyFrom, unstampedKeyIds), 'apiKeyId')
        : Promise.resolve({ cells: [] as SpendCell[], users: [] as SpendUser[] }),
      ApiKeyUsageLog.aggregate<
        GroupedCount<{
          clientId: string;
          endpoint: string;
          standing?: string;
          completionOutcome?: string;
          completionFailureCode?: string;
          statusClass: StatusClass;
        }>
      >([
        { $match: { oauthClientId: { $exists: true }, timestamp: { $gte: windows.requestFrom } } },
        {
          $group: {
            _id: {
              clientId: '$oauthClientId',
              endpoint: '$endpoint',
              standing: '$payerStanding',
              completionOutcome: '$completionObservation.outcome',
              completionFailureCode: '$completionObservation.failureCode',
              statusClass: statusClassExpression,
            },
            count: { $sum: 1 },
          },
        },
      ]).option({ maxTimeMS: MAX_TIME_MS }),
      Quest.aggregate<
        GroupedCount<{ clientId: string; status?: string; type?: string; errorCode?: string; finishReason?: string }>
      >([
        { $match: { oauthClientId: { $exists: true }, timestamp: { $gte: windows.requestFrom } } },
        {
          $group: {
            _id: {
              clientId: '$oauthClientId',
              status: '$status',
              type: '$type',
              errorCode: '$errorCode',
              finishReason: '$promptMeta.finishReason',
            },
            count: { $sum: 1 },
          },
        },
      ]).option({ maxTimeMS: MAX_TIME_MS }),
      AgentExecutionModel.aggregate<GroupedCount<{ clientId: string; status?: string }>>([
        { $match: { oauthClientId: { $exists: true }, createdAt: { $gte: windows.requestFrom } } },
        { $group: { _id: { clientId: '$oauthClientId', status: '$status' }, count: { $sum: 1 } } },
      ]).option({ maxTimeMS: MAX_TIME_MS }),
      SideAppRefusal.aggregate<GroupedCount<{ clientId: string; reason: string }>>([
        { $match: { createdAt: { $gte: windows.requestFrom } } },
        { $group: { _id: { clientId: '$clientId', reason: '$reason' }, count: { $sum: 1 } } },
      ]).option({ maxTimeMS: MAX_TIME_MS }),
      SideAppRefusalCounter.aggregate<{ _id: string; count: number }>([
        { $match: { hour: { $gte: windows.requestFrom } } },
        { $group: { _id: '$reason', count: { $sum: '$count' } } },
      ]).option({ maxTimeMS: MAX_TIME_MS }),
      findAttributionStartedAt(),
    ]);

  const apps = new Map<string, AppAccumulator>();
  const app = (clientId: string) => {
    let accumulator = apps.get(clientId);
    if (!accumulator) apps.set(clientId, (accumulator = newAccumulator()));
    return accumulator;
  };

  const totalTiers = emptyTierCredits();
  const totalDaily = new Map<string, number>();
  const allUsers = new Set<string>();
  const addCell = (clientId: string, cell: SpendCell) => {
    const accumulator = app(clientId);
    accumulator.tiers[cell.bucket] += cell.credits;
    accumulator.daily.set(cell.day, (accumulator.daily.get(cell.day) ?? 0) + cell.credits);
    totalTiers[cell.bucket] += cell.credits;
    totalDaily.set(cell.day, (totalDaily.get(cell.day) ?? 0) + cell.credits);
  };
  const addUser = (clientId: string, user: SpendUser) => {
    app(clientId).users.add(user.userId);
    allUsers.add(user.userId);
  };
  for (const cell of stamped.cells) addCell(cell.key, cell);
  for (const user of stamped.users) addUser(user.key, user);
  for (const cell of unstamped.cells) {
    const clientId = unstampedKeys.get(cell.key);
    if (clientId) addCell(clientId, cell);
  }
  for (const user of unstamped.users) {
    const clientId = unstampedKeys.get(user.key);
    if (clientId) addUser(clientId, user);
  }

  const totalOutcomes = emptyOutcomeCounts();
  for (const row of usageRows) {
    const folded = foldRequestRow({ ...row._id, count: row.count });
    const accumulator = app(row._id.clientId);
    accumulator.requests.total += folded.count;
    accumulator.requests.byTier[folded.tier] += folded.count;
    const endpoint = accumulator.requests.endpoints.get(folded.endpoint) ?? {
      endpoint: folded.endpoint,
      total: 0,
      ...emptyTierRequests(),
    };
    endpoint.total += folded.count;
    endpoint[folded.tier] += folded.count;
    accumulator.requests.endpoints.set(folded.endpoint, endpoint);
    addOutcome(accumulator.outcomes, folded.outcome, folded.count);
    addOutcome(totalOutcomes, folded.outcome, folded.count);
    if (row._id.completionOutcome === 'failed' && row._id.completionFailureCode) {
      const codes = accumulator.failureCodes;
      codes.set(row._id.completionFailureCode, (codes.get(row._id.completionFailureCode) ?? 0) + row.count);
    }
  }
  for (const row of questRows) {
    const outcome = questOutcomeOf(row._id);
    addOutcome(app(row._id.clientId).outcomes, outcome, row.count);
    addOutcome(totalOutcomes, outcome, row.count);
  }
  for (const row of agentRows) {
    const outcome = agentOutcomeOf(row._id.status);
    addOutcome(app(row._id.clientId).outcomes, outcome, row.count);
    addOutcome(totalOutcomes, outcome, row.count);
  }
  for (const row of refusalRows) addRefusal(app(row._id.clientId).refusals, row._id.reason, row.count);

  const unknownClient = emptyRefusals();
  for (const row of counterRows) addRefusal(unknownClient, row._id, row.count);

  const clientIds = [...apps.keys()];
  const clients = clientIds.length ? await oauthClientRepository.findByClientIds(clientIds) : new Map();

  const rows: SideAppRow[] = clientIds.map(clientId => {
    const accumulator = apps.get(clientId) as AppAccumulator;
    return {
      clientId,
      name: clients.get(clientId)?.name ?? clientId,
      spend: {
        credits: sumTiers(accumulator.tiers),
        payingUsers: accumulator.users.size,
        byTier: accumulator.tiers,
        daily: dailySeries(accumulator.daily),
      },
      requests: {
        total: accumulator.requests.total,
        byTier: accumulator.requests.byTier,
        byEndpoint: [...accumulator.requests.endpoints.values()].sort((a, b) => b.total - a.total),
      },
      outcomes: summarizeOutcomes(accumulator.outcomes),
      topFailureCodes: topFailureCodes(accumulator.failureCodes),
      refusals: sortRefusalReasons(accumulator.refusals),
    };
  });
  rows.sort((a, b) => b.spend.credits - a.spend.credits || b.requests.total - a.requests.total);

  const userPaid = totalTiers.paid + totalTiers.unpaid;
  return {
    days: windows.spendDays,
    spendWindowDays: windows.spendDays,
    requestWindowDays: windows.requestDays,
    attributionStartedAt,
    totals: {
      credits: sumTiers(totalTiers),
      activeUsers: allUsers.size,
      byTier: totalTiers,
      unpaidShare: userPaid > 0 ? totalTiers.unpaid / userPaid : null,
      outcomes: summarizeOutcomes(totalOutcomes),
      daily: dailySeries(totalDaily),
    },
    apps: rows,
    unknownClient: sortRefusalReasons(unknownClient),
  };
}
