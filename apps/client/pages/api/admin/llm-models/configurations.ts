import { AdminSettings } from '@bike4mind/database/infra';
import { LLMModelConfig } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError, BadRequestError } from '@server/utils/errors';

// Get LLM Model Configurations (readable by all authenticated users, needed for model selection)
const getHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new ForbiddenError('Authentication required');

  try {
    const setting = await AdminSettings.findOne({ settingName: 'llmModelConfigurations' });
    const configurations = setting?.settingValue || [];

    // Ensure configurations is an array
    if (!Array.isArray(configurations)) {
      return res.json({ settingValue: [] });
    }

    // Ensure we only return essential fields (in case legacy data exists).
    // allowedEntitlements is included only when non-empty so tag-only models
    // stay byte-identical (no behavior change for existing configs).
    const optimizedConfigurations = configurations.map((config: any) => ({
      id: config.id,
      enabled: config.enabled,
      allowedUserTags: config.allowedUserTags,
      ...(Array.isArray(config.allowedEntitlements) &&
        config.allowedEntitlements.length > 0 && { allowedEntitlements: config.allowedEntitlements }),
      ...(config.fallbackModel && { fallbackModel: config.fallbackModel }),
      ...(config.rank !== undefined && { rank: config.rank }),
    }));

    return res.json({ settingValue: optimizedConfigurations });
  } catch (error) {
    return res.json({ settingValue: [] });
  }
});

// Update LLM Model Configurations
const putHandler = asyncHandler<unknown, unknown, { configurations: LLMModelConfig[] }>(async (req, res) => {
  if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

  if (!req.ability) throw new NotFoundError('Ability not found');

  // Basic validation - ensure configurations is an array
  const { configurations } = req.body;
  if (!Array.isArray(configurations)) {
    throw new BadRequestError('Configurations must be an array');
  }

  // Validate each configuration has required fields
  configurations.forEach((config: any, index: number) => {
    if (!config.id || typeof config.id !== 'string') {
      throw new BadRequestError(`Configuration at index ${index} missing required field: id`);
    }
    if (typeof config.enabled !== 'boolean') {
      throw new BadRequestError(`Configuration at index ${index} missing required field: enabled`);
    }
    if (!Array.isArray(config.allowedUserTags)) {
      throw new BadRequestError(`Configuration at index ${index} missing required field: allowedUserTags`);
    }
    // Validate allowedUserTags contains only strings
    config.allowedUserTags.forEach((tag: any, tagIndex: number) => {
      if (typeof tag !== 'string') {
        throw new BadRequestError(`Configuration at index ${index}, allowedUserTags[${tagIndex}] must be a string`);
      }
    });
    // Validate allowedEntitlements if provided (optional - must be a string array)
    if (config.allowedEntitlements !== undefined) {
      if (!Array.isArray(config.allowedEntitlements)) {
        throw new BadRequestError(`Configuration at index ${index}: allowedEntitlements must be an array`);
      }
      config.allowedEntitlements.forEach((key: any, keyIndex: number) => {
        if (typeof key !== 'string') {
          throw new BadRequestError(
            `Configuration at index ${index}, allowedEntitlements[${keyIndex}] must be a string`
          );
        }
      });
    }
    // Validate rank if provided
    if (config.rank !== undefined) {
      if (typeof config.rank !== 'number' || !Number.isInteger(config.rank) || config.rank < 0 || config.rank > 100) {
        throw new BadRequestError(`Configuration at index ${index}: rank must be an integer between 0 and 100`);
      }
    }
  });

  // Optimize configurations to only store essential fields. allowedEntitlements
  // is persisted only when non-empty so existing tag-only models are stored
  // byte-identical (zero regression / no churn on the settings doc).
  const optimizedConfigurations = configurations.map((config: any) => ({
    id: config.id,
    enabled: config.enabled,
    allowedUserTags: config.allowedUserTags,
    ...(Array.isArray(config.allowedEntitlements) &&
      config.allowedEntitlements.length > 0 && { allowedEntitlements: config.allowedEntitlements }),
    ...(config.fallbackModel && { fallbackModel: config.fallbackModel }),
    ...(config.rank !== undefined && { rank: config.rank }),
  }));

  try {
    await AdminSettings.syncIndexes();
    const updatedSetting = await AdminSettings.findOneAndUpdate(
      { settingName: 'llmModelConfigurations' },
      { $set: { settingValue: optimizedConfigurations } },
      { upsert: true, new: true }
    );

    if (!updatedSetting) throw new NotFoundError('Failed to save LLM model configurations');

    // Invalidate cache for this specific setting
    invalidateSettingsCache('llmModelConfigurations');
    req.logger?.info(`🗑️ Invalidated cache for LLM model configurations`);

    return res.json(updatedSetting);
  } catch (error: any) {
    req.logger?.error('Failed to save LLM model configurations:', error);
    throw new NotFoundError(`Failed to save LLM model configurations: ${error.message}`);
  }
});

const handler = baseApi().get(getHandler).put(putHandler);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
