import {
  adminAiDemotedMode,
  adminAiReadiness,
  type AdminAiClassEvidence,
  type AdminAiClassRegistration,
  AdminAiConfigSchema,
  type AdminAiConfig,
  type AdminAiFeature,
} from '@bike4mind/common';
import {
  AdminAiClassModel,
  AdminAiSuggestionModel,
  AdminSettings,
  adminAuditLogRepository,
  withTransaction,
} from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import { systemAuditActor } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/utils';

export type RegisteredAdminAiClass = AdminAiClassRegistration & {
  apply: (suggestionId: string) => Promise<void>;
  undo: (suggestionId: string) => Promise<void>;
};
export const ADMIN_AI_CLASS_REGISTRY: readonly RegisteredAdminAiClass[] = [];
const DAY = 86_400_000;
export type AdminAiClassKey = { feature: AdminAiFeature; actionClass: string; policyVersion: string };

export async function getAdminAiClassReadiness(key: AdminAiClassKey, now = new Date(), config?: AdminAiConfig) {
  let state = await AdminAiClassModel.findOne(key).lean();
  // Demotion only weighs decisions made after the last demotion (ms resolution, so +1 is strictly after).
  const since7 = new Date(
    Math.max(now.getTime() - 7 * DAY, state?.lastDemotedDecision ? state.lastDemotedDecision.getTime() + 1 : 0)
  );
  const [counts] = await AdminAiSuggestionModel.aggregate<{
    accepted: number;
    overridden: number;
    accepted7: number;
    overridden7: number;
    costly: number;
    unclassified: number;
    latest: Date;
  }>([
    {
      $match: {
        ...key,
        status: { $in: ['accepted', 'overridden'] },
        decidedAt: { $gte: new Date(now.getTime() - 14 * DAY), $lte: now },
      },
    },
    {
      $group: {
        _id: null,
        accepted: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
        overridden: { $sum: { $cond: [{ $eq: ['$status', 'overridden'] }, 1, 0] } },
        accepted7: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$status', 'accepted'] }, { $gte: ['$decidedAt', since7] }] }, 1, 0],
          },
        },
        overridden7: {
          $sum: {
            $cond: [
              {
                $and: [{ $eq: ['$status', 'overridden'] }, { $gte: ['$decidedAt', since7] }],
              },
              1,
              0,
            ],
          },
        },
        costly: {
          $sum: { $cond: [{ $and: [{ $eq: ['$status', 'overridden'] }, { $eq: ['$overrideCostly', true] }] }, 1, 0] },
        },
        unclassified: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$status', 'overridden'] }, { $eq: [{ $ifNull: ['$overrideCostly', null] }, null] }] },
              1,
              0,
            ],
          },
        },
        latest: { $max: '$decidedAt' },
      },
    },
  ]);
  const first = await AdminAiSuggestionModel.findOne({
    ...key,
    status: { $in: ['accepted', 'overridden'] },
    decidedAt: { $ne: null, $lte: now },
  })
    .sort({ decidedAt: 1 })
    .select('decidedAt')
    .lean();
  const latest = counts?.latest ?? null;
  if (state) {
    const mode = adminAiDemotedMode(
      state.mode,
      counts?.accepted7 ?? 0,
      counts?.overridden7 ?? 0,
      latest,
      state.lastDemotedDecision
    );
    if (mode !== state.mode) {
      const previous = state;
      await withTransaction(async () => {
        const changed = await AdminAiClassModel.updateOne(
          { ...key, mode: previous.mode, lastDemotedDecision: previous.lastDemotedDecision },
          { $set: { mode, lastDemotedDecision: latest, lastDemotedAt: now } }
        );
        if (changed.modifiedCount)
          await adminAuditService.recordAdminAction(
            {
              action: 'settings.admin_settings.updated',
              actor: systemAuditActor(`admin-ai:${key.feature}`),
              target: {
                kind: 'settings',
                id: `adminAiClass:${key.feature}:${key.actionClass}:${key.policyVersion}`,
                displayName: key.actionClass,
              },
              summary: 'automatically demoted admin AI class',
              changes: [{ field: 'mode', before: previous.mode, after: mode }],
              details: {
                ...key,
                accepted: counts?.accepted7 ?? 0,
                overridden: counts?.overridden7 ?? 0,
                latestDecision: latest,
              },
              context: { source: 'worker' },
            },
            { db: { adminAuditLog: adminAuditLogRepository } }
          );
      });
      state = await AdminAiClassModel.findOne(key).lean();
    }
  }
  const evidence: AdminAiClassEvidence = {
    ...key,
    mode: state?.mode ?? 'shadow',
    replayCases: state?.replayCases ?? 0,
    replayAgreed: state?.replayAgreed ?? 0,
    replayArtifact: state?.replayArtifact ?? '',
    onlineAccepted: counts?.accepted ?? 0,
    onlineOverridden: counts?.overridden ?? 0,
    onlineDays: first?.decidedAt ? Math.max(0, (now.getTime() - first.decidedAt.getTime()) / DAY) : 0,
    costlyOverrides: counts?.costly ?? 0,
    unclassifiedOverrides: counts?.unclassified ?? 0,
  };
  const registration = ADMIN_AI_CLASS_REGISTRY.find(
    r =>
      r.feature === key.feature &&
      r.actionClass === key.actionClass &&
      r.policyVersion === key.policyVersion &&
      typeof r.apply === 'function' &&
      typeof r.undo === 'function'
  );
  const readiness = adminAiReadiness(evidence, registration);
  config ??= AdminAiConfigSchema.parse(
    (await AdminSettings.findOne({ settingName: 'adminAiConfig' }).lean())?.settingValue ?? {}
  );
  const featureMode = config.features[key.feature].mode;
  return {
    ...readiness,
    evidence,
    mode: evidence.mode,
    undoPath: readiness.registered ? registration?.undoPath : undefined,
    canRecommend:
      config.enabled &&
      (featureMode === 'recommend' || featureMode === 'act') &&
      (evidence.mode === 'recommend' || evidence.mode === 'act') &&
      readiness.recommend,
    canAct: config.enabled && featureMode === 'act' && evidence.mode === 'act' && readiness.act,
  };
}

export async function validateAdminAiConfigPromotion(config: AdminAiConfig) {
  if (!config.enabled) return;
  const stored = await AdminSettings.findOne({ settingName: 'adminAiConfig' }).lean();
  const previous = AdminAiConfigSchema.parse(stored?.settingValue ?? {});
  const rank = { off: 0, shadow: 1, recommend: 2, act: 3 };
  for (const [feature, value] of Object.entries(config.features)) {
    if (value.mode !== 'recommend' && value.mode !== 'act') continue;
    if (previous.enabled && rank[value.mode] <= rank[previous.features[feature as AdminAiFeature].mode]) continue;
    const classes = await AdminAiClassModel.find({ feature }).lean();
    if (!classes.length) throw new BadRequestError(`${feature}: offline replay evidence is required`);
    for (const cls of classes) {
      const ready = await getAdminAiClassReadiness({
        feature: cls.feature,
        actionClass: cls.actionClass,
        policyVersion: cls.policyVersion,
      });
      if (!ready.recommend || (value.mode === 'act' && !ready.act)) {
        throw new BadRequestError(
          `${feature}/${cls.actionClass}: insufficient evidence or missing reversible handler and Undo`
        );
      }
    }
  }
}
