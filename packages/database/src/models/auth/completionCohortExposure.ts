import { UsageEvent } from '../billing/UsageEventModel';

export type CompletionCohortSpend = {
  userId: string;
  creditsCharged: number;
  grantFundedCredits: number;
  unknownFundingCredits: number;
};

/** Grant-funded includes rewards and other grants; it does not establish signup-credit abuse. */
export async function loadCompletionCohortExposure(userIds: readonly string[], now: Date) {
  const ids = [...new Set(userIds)].slice(0, 500);
  const rows = await UsageEvent.find({
    userId: { $in: ids },
    feature: 'completion_api',
    status: 'ok',
    createdAt: { $gte: new Date(now.getTime() - 86_400_000), $lt: now },
  })
    .select('userId creditsCharged fundingBreakdown')
    .sort({ createdAt: -1 })
    .limit(5_001)
    .maxTimeMS(10_000)
    .lean();
  const totals = new Map<string, CompletionCohortSpend>();
  for (const row of rows.slice(0, 5_000)) {
    const total = totals.get(row.userId) ?? {
      userId: row.userId,
      creditsCharged: 0,
      grantFundedCredits: 0,
      unknownFundingCredits: 0,
    };
    const charge = Number.isFinite(row.creditsCharged) ? Math.max(0, row.creditsCharged) : 0;
    const funding = row.fundingBreakdown;
    const amounts = funding ? [funding.granted, funding.purchased, funding.subscription, funding.unknown] : [];
    const valid =
      amounts.length === 4 &&
      amounts.every(amount => Number.isFinite(amount) && amount >= 0) &&
      Math.abs(amounts.reduce((sum, amount) => sum + amount, 0) - charge) < 0.001;
    total.creditsCharged += charge;
    total.grantFundedCredits += valid && funding ? funding.granted : 0;
    total.unknownFundingCredits += valid && funding ? funding.unknown : charge;
    totals.set(row.userId, total);
  }
  return { accounts: [...totals.values()], truncated: rows.length > 5_000 || new Set(userIds).size > 500 };
}
