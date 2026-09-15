import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { RapidReplyResponseStyleCommon } from '@bike4mind/common';
import { findRottedRapidModelIds } from '@server/rapidReply/rapidMappingHealth';

/** The model listing `findRottedRapidModelIds` judges against, for this admin caller. */
async function listRunnableModels(mappings: { rapidModelId: string }[], userId: string) {
  // Before the fan-out, not after: nothing to check means no reason to pay for a model listing.
  if (mappings.length === 0) {
    return [];
  }

  const apiKeys = buildApiKeyTable(
    await apiKeyService.getEffectiveLLMApiKeys(userId, {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    })
  );
  // No listing options, so this observes the same list the rapid-reply endpoint does (private
  // models included, resolved by id) rather than the picker's narrower view.
  return getAvailableModels(apiKeys);
}

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const mappings = await rapidReplyMappingRepository.findAll();
    const models = await listRunnableModels(mappings, req.user.id);

    return res.json({ mappings, unavailableRapidModelIds: findRottedRapidModelIds(mappings, models) });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const {
      mainModelId,
      rapidModelId,
      enabled = true,
      priority = 1,
      systemPrompt,
      maxTokens = 150,
      responseStyle = 'auto',
      maxLatency = 2000,
    } = req.body as {
      mainModelId: string;
      rapidModelId: string;
      enabled?: boolean;
      priority?: number;
      systemPrompt: string;
      maxTokens?: number;
      responseStyle?: RapidReplyResponseStyleCommon;
      maxLatency?: number;
    };

    if (!mainModelId || !rapidModelId || !systemPrompt) {
      throw new BadRequestError('mainModelId, rapidModelId, and systemPrompt are required');
    }

    // Check if mapping already exists for this main model
    const existingMapping = await rapidReplyMappingRepository.findByMainModel(mainModelId);
    if (existingMapping) {
      throw new BadRequestError('A mapping already exists for this main model');
    }

    const newMapping = await rapidReplyMappingRepository.createMapping({
      mainModelId,
      rapidModelId,
      enabled,
      priority,
      systemPrompt,
      maxTokens,
      responseStyle,
      maxLatency,
      createdBy: req.user!.id,
      usageCount: 0,
    });

    await rapidReplyAuditLogRepository.createLog({
      entityType: 'mapping',
      entityId: newMapping.id,
      action: 'create',
      changes: {
        mapping: { after: newMapping },
      },
      userId: req.user!.id,
      userEmail: req.user!.email || undefined,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json(newMapping);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
