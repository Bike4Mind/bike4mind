import { ADMIN_AI_FEATURES, AdminAiConfigSchema, type AdminAiFeature } from '@bike4mind/common';
import { AdminAiAttemptModel, AdminAiClassModel, AdminAiSuggestionModel, AdminSettings } from '@bike4mind/database';
import { getAdminAiClassReadiness } from './readiness';

export async function loadAdminAiConfig() {
  const row = await AdminSettings.findOne({ settingName: 'adminAiConfig' }).lean();
  return AdminAiConfigSchema.parse(row?.settingValue ?? {});
}

export async function getAdminAiOperations(now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(Math.min(month.getTime(), now.getTime() - 30 * 86_400_000));
  const [config, attempts, suggestions, classes, recent] = await Promise.all([
    loadAdminAiConfig(),
    AdminAiAttemptModel.aggregate<{
      _id: AdminAiFeature;
      today: number;
      month: number;
      calls: number;
      unknown: number;
      skips: { reason: string; count: number }[];
    }>([
      { $match: { startedAt: { $gte: since, $lte: now } } },
      {
        $group: {
          _id: { feature: '$feature', skip: '$skipReason' },
          today: { $sum: { $cond: [{ $gte: ['$startedAt', day] }, '$knownCostUsd', 0] } },
          month: { $sum: { $cond: [{ $gte: ['$startedAt', month] }, '$knownCostUsd', 0] } },
          calls: { $sum: { $cond: [{ $gte: ['$startedAt', day] }, '$calls', 0] } },
          unknown: { $sum: { $cond: ['$costUnknown', 1, 0] } },
          skips: { $sum: { $cond: [{ $eq: ['$outcome', 'skip'] }, 1, 0] } },
        },
      },
      {
        $group: {
          _id: '$_id.feature',
          today: { $sum: '$today' },
          month: { $sum: '$month' },
          calls: { $sum: '$calls' },
          unknown: { $sum: '$unknown' },
          skips: { $push: { reason: '$_id.skip', count: '$skips' } },
        },
      },
    ]),
    AdminAiSuggestionModel.aggregate<{
      _id: AdminAiFeature;
      accepted7: number;
      overridden7: number;
      accepted30: number;
      overridden30: number;
    }>([
      {
        $match: {
          decidedAt: { $gte: new Date(now.getTime() - 30 * 86_400_000), $lte: now },
          status: { $in: ['accepted', 'overridden'] },
        },
      },
      {
        $group: {
          _id: '$feature',
          accepted7: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'accepted'] },
                    { $gte: ['$decidedAt', new Date(now.getTime() - 7 * 86_400_000)] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          overridden7: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'overridden'] },
                    { $gte: ['$decidedAt', new Date(now.getTime() - 7 * 86_400_000)] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          accepted30: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
          overridden30: { $sum: { $cond: [{ $eq: ['$status', 'overridden'] }, 1, 0] } },
        },
      },
    ]),
    AdminAiClassModel.find().select('feature actionClass policyVersion').lean(),
    AdminAiSuggestionModel.find({ status: { $in: ['overridden', 'auto_applied', 'undone'] } })
      .sort({ decidedAt: -1, _id: -1 })
      .limit(50)
      .select('feature actionClass policyVersion entityId status decidedAt overrideReason')
      .lean(),
  ]);
  // Old successful suggestions remain measurable; attempts are authoritative once a suggestion is linked.
  const legacy = await AdminAiSuggestionModel.aggregate<{
    _id: AdminAiFeature;
    today: number;
    month: number;
    unknown: number;
  }>([
    { $match: { createdAt: { $gte: month, $lte: now } } },
    {
      $lookup: {
        from: 'AdminAiAttempt',
        let: { id: { $toString: '$_id' } },
        pipeline: [{ $match: { outcome: 'suggestion', $expr: { $eq: ['$suggestionId', '$$id'] } } }, { $limit: 1 }],
        as: 'attempts',
      },
    },
    { $match: { attempts: { $size: 0 } } },
    {
      $group: {
        _id: '$feature',
        today: { $sum: { $cond: [{ $gte: ['$createdAt', day] }, '$costUsd', 0] } },
        month: { $sum: '$costUsd' },
        unknown: { $sum: { $cond: ['$costUnknown', 1, 0] } },
      },
    },
  ]);
  const features = ADMIN_AI_FEATURES.map(feature => {
    const run = attempts.find(row => row._id === feature);
    const old = legacy.find(row => row._id === feature);
    const agreement = suggestions.find(row => row._id === feature);
    return {
      feature,
      mode: config.features[feature].mode,
      todayUsd: (run?.today ?? 0) + (old?.today ?? 0),
      monthUsd: (run?.month ?? 0) + (old?.month ?? 0),
      callsToday: run?.calls ?? 0,
      unknownCostAttempts: (run?.unknown ?? 0) + (old?.unknown ?? 0),
      skips: (run?.skips ?? []).filter(s => s.count > 0),
      accepted7: agreement?.accepted7 ?? 0,
      overridden7: agreement?.overridden7 ?? 0,
      accepted30: agreement?.accepted30 ?? 0,
      overridden30: agreement?.overridden30 ?? 0,
    };
  });
  const classReadiness = await Promise.all(
    classes.map(cls =>
      getAdminAiClassReadiness(
        {
          feature: cls.feature,
          actionClass: cls.actionClass,
          policyVersion: cls.policyVersion,
        },
        now,
        config
      )
    )
  );
  const monthUsd = features.reduce((sum, row) => sum + row.monthUsd, 0);
  return {
    config,
    features,
    classes: classReadiness,
    monthUsd,
    budgetState:
      config.monthlyCapUsd <= 0 || monthUsd >= config.monthlyCapUsd
        ? 'stopped'
        : monthUsd >= config.monthlyCapUsd * 0.8
          ? 'warning'
          : 'normal',
    coverage:
      'Successful historical suggestions are included. Historical skips, failed-call spend and call counts before durable attempts are unavailable. Unknown costs are not included in known spend; budget holds remain enforced.',
    recent: recent.map(row => ({
      id: row._id.toString(),
      feature: row.feature,
      entityId: row.entityId,
      actionClass: row.actionClass,
      policyVersion: row.policyVersion,
      status: row.status,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      overrideReason: row.overrideReason,
      undoPath:
        row.status === 'auto_applied'
          ? classReadiness.find(
              c =>
                c.evidence.feature === row.feature &&
                c.evidence.actionClass === row.actionClass &&
                c.evidence.policyVersion === row.policyVersion
            )?.undoPath
          : undefined,
    })),
  };
}

export type AdminAiOperations = Awaited<ReturnType<typeof getAdminAiOperations>>;
