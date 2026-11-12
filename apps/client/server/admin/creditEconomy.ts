import {
  CreditTransaction,
  CreditLot,
  UsageEvent,
  User,
  Organization,
  executeFacetCompatible,
} from '@bike4mind/database';
import type { PipelineStage } from 'mongoose';
import { z } from 'zod';
import {
  ECONOMY_FLOWS,
  ECONOMY_LIMITATIONS,
  type EconomyQueryInput,
  type EconomyFlow,
  type EconomyReportData,
  EconomyRow,
} from '../../shared/creditEconomy';

const MAX_TIME_MS = 15000;
const fundingKeys = ['purchased', 'subscription', 'granted', 'unknown'] as const;
const emptyFunding = () => ({ purchased: 0, subscription: 0, granted: 0, unknown: 0 });
const isNumeric = (field: string) => ({ $in: [{ $type: field }, ['int', 'long', 'double', 'decimal']] });
const reasons = (values: string[]) => ({ $in: ['$reason', values] });
const typeIs = (type: string) => ({ $eq: ['$type', type] });
const genericReason = (types: string[], values: string[]) => ({
  $and: [{ $in: ['$type', types] }, reasons(values)],
});

export const economyFlowExpression = {
  $switch: {
    branches: [
      { case: { $and: [typeIs('purchase'), { $ne: ['$status', 'completed'] }] }, then: 'non_balance' },
      { case: typeIs('purchase'), then: 'purchased' },
      { case: typeIs('subscription'), then: 'subscription' },
      { case: { $in: ['$type', ['transfer_credit', 'received_credit']] }, then: 'transfers' },
      { case: genericReason(['generic_deduct'], ['credit_expiry']), then: 'expired' },
      {
        case: genericReason(
          ['generic_deduct'],
          [
            'dispute_clawback',
            'refund_clawback',
            'payment_failed_clawback',
            'abuse_clawback',
            'referral_reward_takeback',
          ]
        ),
        then: 'reversed',
      },
      {
        case: genericReason(
          ['generic_add', 'generic_deduct'],
          ['admin_adjustment', 'manual', 'adjustment', 'refund_adjustment']
        ),
        then: 'adjustments',
      },
      { case: genericReason(['generic_add'], ['refund']), then: 'refunds' },
      {
        case: genericReason(['generic_add'], ['admin_grant', 'promo', 'signup_tranche', 'referral_reward']),
        then: 'granted',
      },
      { case: { $regexMatch: { input: '$type', regex: '_usage$' } }, then: 'consumed' },
    ],
    default: 'unknown',
  },
};

export function economyStages(query: EconomyQueryInput): PipelineStage[] {
  return [
    {
      $match: {
        createdAt: { $gte: new Date(query.from), $lt: new Date(query.to) },
        ownerType: query.ownerType === 'all' ? { $in: ['User', 'Organization', 'Agent'] } : query.ownerType,
      },
    },
    { $addFields: { flow: economyFlowExpression } },
    { $addFields: { delta: { $cond: [{ $eq: ['$flow', 'non_balance'] }, 0, '$credits'] } } },
  ];
}

type FlowBucket = { _id: EconomyFlow; credits: number; rows: number };
export async function readEconomyPage(query: EconomyQueryInput) {
  const rawResult: unknown = await executeFacetCompatible(
    CreditTransaction,
    [...economyStages(query), ...(query.flow ? [{ $match: { flow: query.flow } }] : [])],
    {
      rows: [
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (query.page - 1) * query.limit },
        { $limit: query.limit },
        {
          $project: {
            _id: 0,
            id: { $toString: '$_id' },
            at: { $dateToString: { date: '$createdAt', format: '%Y-%m-%dT%H:%M:%S.%LZ' } },
            ownerId: 1,
            ownerType: 1,
            type: 1,
            reason: { $ifNull: ['$reason', null] },
            credits: 1,
            delta: 1,
            flow: 1,
          },
        },
      ],
      count: [{ $count: 'total' }],
    },
    { maxTimeMS: MAX_TIME_MS }
  );
  const [result] = z
    .array(
      z.object({
        rows: z.array(EconomyRow),
        count: z.array(z.object({ total: z.number().int().nonnegative() })),
      })
    )
    .parse(rawResult);
  return { rows: result?.rows ?? [], total: result?.count[0]?.total ?? 0 };
}

export async function readEconomyReport(query: EconomyQueryInput, now = new Date()): Promise<EconomyReportData> {
  const ownerMatch =
    query.ownerType === 'all'
      ? { ownerType: { $in: ['User', 'Organization', 'Agent'] } }
      : { ownerType: query.ownerType };
  const aggregateBalance = async (kind: 'User' | 'Organization') => {
    if (query.ownerType !== 'all' && query.ownerType !== kind) return [];
    const stages: PipelineStage[] = [
      {
        $group: {
          _id: null,
          available: { $sum: '$currentCredits' },
          holders: { $sum: 1 },
          missing: { $sum: { $cond: [isNumeric('$currentCredits'), 0, 1] } },
        },
      },
    ];
    return kind === 'User'
      ? User.aggregate<{ available: number; holders: number; missing: number }>(stages).option({
          maxTimeMS: MAX_TIME_MS,
        })
      : Organization.aggregate<{ available: number; holders: number; missing: number }>(stages).option({
          maxTimeMS: MAX_TIME_MS,
        });
  };
  const [flows, usage, lots, users, organizations, cohorts] = await Promise.all([
    CreditTransaction.aggregate<FlowBucket>([
      ...economyStages(query),
      { $group: { _id: '$flow', credits: { $sum: '$delta' }, rows: { $sum: 1 } } },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
    UsageEvent.aggregate<{ total: number; rows: number; stamped: number; funding: ReturnType<typeof emptyFunding> }>([
      { $match: { ...ownerMatch, createdAt: { $gte: new Date(query.from), $lt: new Date(query.to) } } },
      {
        $addFields: {
          debited: { $max: [0, { $subtract: ['$creditsCharged', { $ifNull: ['$writtenOffCredits', 0] }] }] },
          validStamp: {
            $and: [
              { $gt: ['$creditsCharged', 0] },
              ...fundingKeys.map(key => ({
                $and: [isNumeric(`$fundingBreakdown.${key}`), { $gte: [`$fundingBreakdown.${key}`, 0] }],
              })),
              {
                $lte: [
                  {
                    $abs: {
                      $subtract: [
                        {
                          $add: fundingKeys.map(key => ({
                            $cond: [isNumeric(`$fundingBreakdown.${key}`), `$fundingBreakdown.${key}`, 0],
                          })),
                        },
                        '$creditsCharged',
                      ],
                    },
                  },
                  0.000001,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$debited' },
          rows: { $sum: 1 },
          stamped: { $sum: { $cond: ['$validStamp', 1, 0] } },
          ...Object.fromEntries(
            fundingKeys.map(key => [
              key,
              {
                $sum: {
                  $cond: [
                    '$validStamp',
                    { $multiply: [`$fundingBreakdown.${key}`, { $divide: ['$debited', '$creditsCharged'] }] },
                    key === 'unknown' ? '$debited' : 0,
                  ],
                },
              },
            ])
          ),
        },
      },
      {
        $project: {
          total: 1,
          rows: 1,
          stamped: 1,
          funding: Object.fromEntries(fundingKeys.map(key => [key, `$${key}`])),
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
    CreditLot.aggregate<{ _id: string; remaining: number; count: number }>([
      { $match: { ...ownerMatch, expiresAt: { $gt: now }, settledAt: { $exists: false } } },
      {
        $group: {
          _id: {
            $ifNull: [
              '$fundingSource',
              {
                $switch: {
                  branches: [
                    { case: { $eq: ['$source', 'pack'] }, then: 'purchased' },
                    { case: { $eq: ['$source', 'subscription'] }, then: 'subscription' },
                    { case: { $eq: ['$source', 'promo'] }, then: 'granted' },
                  ],
                  default: 'unknown',
                },
              },
            ],
          },
          remaining: { $sum: { $max: [0, { $subtract: ['$amount', '$consumedAssigned'] }] } },
          count: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
    aggregateBalance('User'),
    aggregateBalance('Organization'),
    CreditTransaction.aggregate<{ _id: null; days7: number; days30: number; credits7: number; credits30: number }>([
      {
        $match: {
          ...ownerMatch,
          type: 'purchase',
          status: 'completed',
          createdAt: { $gte: new Date(query.from), $lt: new Date(query.to) },
        },
      },
      {
        $group: {
          _id: null,
          ...Object.fromEntries(
            [7, 30].flatMap(days => {
              const mature = { $lte: ['$createdAt', new Date(now.getTime() - days * 86400000)] };
              return [
                [`days${days}`, { $sum: { $cond: [mature, 1, 0] } }],
                [`credits${days}`, { $sum: { $cond: [mature, '$credits', 0] } }],
              ];
            })
          ),
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
  ]);
  const currentLotRemainingEstimate = emptyFunding();
  for (const lot of lots) {
    const key = fundingKeys.find(key => key === lot._id) ?? 'unknown';
    currentLotRemainingEstimate[key] += lot.remaining;
  }
  const balances = [...users, ...organizations];
  const missingBalances = balances.reduce((sum, row) => sum + row.missing, 0);
  const ledgerConsumption = -(flows.find(row => row._id === 'consumed')?.credits ?? 0);
  const usageDebited = usage[0]?.total ?? 0;
  return {
    from: query.from,
    to: query.to,
    asOf: now.toISOString(),
    ownerType: query.ownerType,
    flows: ECONOMY_FLOWS.map(flow => ({
      flow,
      credits: flows.find(row => row._id === flow)?.credits ?? 0,
      rows: flows.find(row => row._id === flow)?.rows ?? 0,
    })),
    netMovement: flows.reduce((sum, row) => sum + row.credits, 0),
    transactionCount: flows.reduce((sum, row) => sum + row.rows, 0),
    balances: {
      opening: null,
      closing: null,
      held: null,
      reconciliationDifference: null,
      currentAvailable:
        query.ownerType === 'Agent' || query.ownerType === 'all' || missingBalances > 0
          ? null
          : balances.reduce((sum, row) => sum + row.available, 0),
      holders: balances.reduce((sum, row) => sum + row.holders, 0),
      missingBalances,
    },
    funding: {
      consumption: usage[0]?.funding ?? emptyFunding(),
      usageDebited,
      usageRows: usage[0]?.rows ?? 0,
      stampedRows: usage[0]?.stamped ?? 0,
      invalidOrMissingRows: (usage[0]?.rows ?? 0) - (usage[0]?.stamped ?? 0),
      ledgerConsumption,
      ledgerUsageDifference: ledgerConsumption - usageDebited,
      currentLotRemainingEstimate,
      lotCount: lots.reduce((sum, row) => sum + row.count, 0),
    },
    cohorts: [7, 30].map(days => ({
      days,
      maturePurchases: (days === 7 ? cohorts[0]?.days7 : cohorts[0]?.days30) ?? 0,
      issuedCredits: (days === 7 ? cohorts[0]?.credits7 : cohorts[0]?.credits30) ?? 0,
      attributablePurchases: 0,
      consumedCredits: null,
    })),
    limitations: [
      ...ECONOMY_LIMITATIONS,
      'Current available is unavailable for all-owner/agent scope: agent balance pools are not included in the user/organization balance read. Holder counts cover users/organizations only.',
    ],
  };
}
