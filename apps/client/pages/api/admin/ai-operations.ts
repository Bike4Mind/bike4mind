import { z } from 'zod';
import { ADMIN_AI_FEATURES, ADMIN_AI_MODES, AdminAiConfigSchema, adminAiReadiness } from '@bike4mind/common';
import { AdminAiClassModel, AdminSettings, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { getAdminAiOperations, loadAdminAiConfig } from '@server/admin/ai/operations';
import {
  getAdminAiClassReadiness,
  ADMIN_AI_CLASS_REGISTRY,
  validateAdminAiConfigPromotion,
} from '@server/admin/ai/readiness';
import { recordAdminSettingChange } from '@bike4mind/server-utils/utils/adminSettingsAudit';
import { BadRequestError, invalidateSettingsCache } from '@bike4mind/utils';

const classUpdate = z.object({
  feature: z.enum(ADMIN_AI_FEATURES),
  actionClass: z.string().min(1).max(100),
  policyVersion: z.string().min(1).max(100),
  mode: z.enum(ADMIN_AI_MODES),
  replayCases: z.number().int().min(0),
  replayAgreed: z.number().int().min(0),
  replayArtifact: z.string().max(1000),
});

export default adminApi({
  adminPermissions: { GET: 'settings:manage', PUT: 'settings:manage', POST: 'settings:manage' },
})
  .get(async (_req, res) => res.json(await getAdminAiOperations()))
  .put(async (req, res) => {
    const config = AdminAiConfigSchema.parse(req.body);
    await validateAdminAiConfigPromotion(config);
    await withTransaction(async () => {
      const before = await loadAdminAiConfig();
      await AdminSettings.findOneAndUpdate(
        { settingName: 'adminAiConfig' },
        { $set: { settingValue: config } },
        { upsert: true }
      );
      await recordAdminSettingChange(req, { settingName: 'adminAiConfig', before, after: config });
    });
    invalidateSettingsCache('adminAiConfig');
    res.json(await getAdminAiOperations());
  })
  .post(async (req, res) => {
    const update = classUpdate.parse(req.body);
    if (update.replayAgreed > update.replayCases) throw new BadRequestError('Agreed cases cannot exceed replay cases');
    const key = { feature: update.feature, actionClass: update.actionClass, policyVersion: update.policyVersion };
    const current = await getAdminAiClassReadiness(key);
    const ready = adminAiReadiness(
      { ...current.evidence, ...update },
      ADMIN_AI_CLASS_REGISTRY.find(
        r => r.feature === key.feature && r.actionClass === key.actionClass && r.policyVersion === key.policyVersion
      )
    );
    if ((update.mode === 'recommend' && !ready.recommend) || (update.mode === 'act' && !ready.act)) {
      throw new BadRequestError(
        'Promotion requires ladder evidence and act requires a registered reversible handler with Undo'
      );
    }
    await withTransaction(async () => {
      const before = await AdminAiClassModel.findOne(key).lean();
      await AdminAiClassModel.findOneAndUpdate(key, { $set: update }, { upsert: true, runValidators: true });
      await recordAdminSettingChange(req, {
        settingName: 'adminAiConfig',
        before,
        after: update,
        target: {
          id: `adminAiClass:${key.feature}:${key.actionClass}:${key.policyVersion}`,
          displayName: key.actionClass,
        },
      });
    });
    res.json(await getAdminAiOperations());
  });
