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

export async function getAdminAiClassReadiness(key: AdminAiClassKey, now = new Date()) {
  let state = await AdminAiClassModel.findOne(key).lean();
  const decided = await AdminAiSuggestionModel.find({
    ...key,
    status: { $in: ['accepted', 'overridden'] },
    decidedAt: { $gte: new Date(now.getTime() - 14 * DAY), $lte: now },
  })
    .select('status decidedAt overrideCostly')
    .lean();
  const first = await AdminAiSuggestionModel.findOne({
    ...key,
    status: { $in: ['accepted', 'overridden'] },
    decidedAt: { $ne: null, $lte: now },
  })
    .sort({ decidedAt: 1 })
    .select('decidedAt')
    .lean();
  const recent = decided.filter(row => row.decidedAt && row.decidedAt.getTime() >= now.getTime() - 7 * DAY);
  const latest = recent.reduce<Date | null>(
    (last, row) => (row.decidedAt && (!last || row.decidedAt > last) ? row.decidedAt : last),
    null
  );
  if (state) {
    const mode = adminAiDemotedMode(
      state.mode,
      recent.filter(r => r.status === 'accepted').length,
      recent.filter(r => r.status === 'overridden').length,
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
                accepted: recent.filter(r => r.status === 'accepted').length,
                overridden: recent.filter(r => r.status === 'overridden').length,
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
    onlineAccepted: decided.filter(r => r.status === 'accepted').length,
    onlineOverridden: decided.filter(r => r.status === 'overridden').length,
    onlineDays: first?.decidedAt ? Math.max(0, (now.getTime() - first.decidedAt.getTime()) / DAY) : 0,
    costlyOverrides: decided.filter(r => r.status === 'overridden' && r.overrideCostly === true).length,
    unclassifiedOverrides: decided.filter(r => r.status === 'overridden' && r.overrideCostly == null).length,
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
  return {
    ...readiness,
    evidence,
    mode: evidence.mode,
    undoPath: readiness.registered ? registration?.undoPath : undefined,
    canRecommend: (evidence.mode === 'recommend' || evidence.mode === 'act') && readiness.recommend,
    canAct: evidence.mode === 'act' && readiness.act,
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
