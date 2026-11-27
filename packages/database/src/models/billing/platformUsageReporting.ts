export const platformUsageExpression = { $eq: ['$attribution.kind', 'platform_operation'] };

export const effectiveUsageDate = {
  $cond: [platformUsageExpression, '$usageOccurredAt', '$createdAt'],
};

export const attributedUsageMatch = { 'attribution.kind': { $ne: 'platform_operation' } };

export function usageTimeMatch(from?: Date, to?: Date): Record<string, unknown> {
  const bounds = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
  if (!from && !to) return {};
  return {
    $or: [
      { 'attribution.kind': 'platform_operation', usageOccurredAt: bounds },
      { ...attributedUsageMatch, createdAt: bounds },
    ],
  };
}
