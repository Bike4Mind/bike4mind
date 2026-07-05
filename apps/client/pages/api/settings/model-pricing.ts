import { AdminSettings } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

// Update model pricing setting (bypasses SettingKeySchema validation)
const handler = baseApi().put(
  asyncHandler<unknown, unknown, { key: string; value: string }>(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const { key, value } = req.body;

    // Validate that this is a model pricing key
    if (!key || !key.startsWith('modelPricing_')) {
      throw new Error('Invalid model pricing key format');
    }

    if (!req.ability) throw new NotFoundError('Ability not found');

    // Check permissions
    if (!req.ability.can('update', AdminSettings)) throw new NotFoundError('Permission denied');

    await AdminSettings.syncIndexes();
    const updatedSetting = await AdminSettings.findOneAndUpdate(
      { settingName: key },
      { $set: { settingValue: value } },
      { upsert: true, new: true }
    );

    if (!updatedSetting) throw new NotFoundError('Failed to save model pricing setting');

    req.logger?.info(`Model pricing setting updated: ${key}`);

    return res.json(updatedSetting);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
