import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { ForbiddenError, BadRequestError, InternalServerError, getSettingsByNames } from '@bike4mind/utils';
import { isSelectableAgentOpsModel } from '@client/app/utils/agentOpsModels';

interface CreateUpdateSettingsRequest {
  generationLlmModel?: string;
  rateLimitSeconds?: number;
  isEnabled?: boolean;
}

interface AddVersionRequest {
  metaPrompt: string;
  description: string;
}

/**
 * The models an admin may pin, read from the live catalog rather than a hand-maintained list --
 * the picker in AgentOpsTab reads the same catalog through /api/models, so it cannot offer a
 * model this endpoint then rejects, and a newly added model is selectable the day it ships.
 *
 * Deprecated IDs are absent because getAvailableModels drops them: pinning one is a new write,
 * and there is no reason to let an admin newly select a retired model. Existing documents pinned
 * to one keep working via resolveDeprecatedModelId.
 *
 * Every option here must match /api/models exactly: getModelCacheKey folds includePrivate's
 * siblings and perBackendTimeoutMs into the cache key, so differing on any of them would put
 * this route in its own cache slot and let the two sides observe different lists -- the drift
 * this change exists to remove.
 */
const BACKEND_TIMEOUT_MS = 2_000;

async function fetchSelectableModels(userId: string) {
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);
  return getAvailableModels(buildApiKeyTable(coreKeys), {
    perBackendTimeoutMs: BACKEND_TIMEOUT_MS,
    includePrivate: false,
    isSelfHost: process.env.B4M_SELF_HOST === 'true',
  });
}

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user!.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const settings = await agentOpsSettingsRepository.getSettings();

    if (!settings) {
      const defaultSettings = {
        id: '',
        versions: [],
        currentVersionNumber: 1,
        generationLlmModel: 'claude-opus-4-20250514' as const,
        rateLimitSeconds: 60,
        totalGenerationsCount: 0,
        lastGenerationAt: null,
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return res.json(defaultSettings);
    }

    res.json(settings);
  })
  .put<Request<{}, {}, CreateUpdateSettingsRequest>>(async (req, res) => {
    if (!req.user!.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const { generationLlmModel, rateLimitSeconds, isEnabled } = req.body;

    if (generationLlmModel) {
      const models = await fetchSelectableModels(req.user!.id);
      // An empty catalog means every backend listing failed; rejecting the save would read as
      // "bad model" when the model is fine, so fail loudly instead of blaming the input.
      if (models.length === 0) {
        throw new InternalServerError('Model catalog is unavailable; try again shortly');
      }
      if (!isSelectableAgentOpsModel(models, generationLlmModel)) {
        throw new BadRequestError('Invalid LLM model specified');
      }
    }

    if (rateLimitSeconds !== undefined && (rateLimitSeconds < 0 || rateLimitSeconds > 3600)) {
      throw new BadRequestError('Rate limit must be between 0 and 3600 seconds');
    }

    const updateData: any = {};
    if (generationLlmModel) updateData.generationLlmModel = generationLlmModel;
    if (rateLimitSeconds !== undefined) updateData.rateLimitSeconds = rateLimitSeconds;
    if (isEnabled !== undefined) updateData.isEnabled = isEnabled;

    const updatedSettings = await agentOpsSettingsRepository.createOrUpdateSettings(updateData);
    res.json(updatedSettings);
  })
  .post<Request<{}, {}, AddVersionRequest>>(async (req, res) => {
    if (!req.user!.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const { metaPrompt, description } = req.body;

    if (!metaPrompt || !metaPrompt.trim()) {
      throw new BadRequestError('Meta-prompt content is required');
    }

    if (metaPrompt.length > 50000) {
      throw new BadRequestError('Meta-prompt is too long (max 50,000 characters)');
    }

    // Ensure settings exist before adding a version
    let settings = await agentOpsSettingsRepository.getSettings();
    if (!settings) {
      settings = await agentOpsSettingsRepository.createOrUpdateSettings({
        generationLlmModel: 'claude-opus-4-20250514',
        rateLimitSeconds: 60,
        isEnabled: true,
        totalGenerationsCount: 0,
        lastGenerationAt: null,
        versions: [],
        currentVersionNumber: 1,
      });
    }

    const updatedSettings = await agentOpsSettingsRepository.addMetaPromptVersion(
      metaPrompt.trim(),
      description?.trim() || '',
      req.user!.id
    );

    // Auto-activate the first version
    if (updatedSettings.versions.length === 1) {
      const activatedSettings = await agentOpsSettingsRepository.activateMetaPromptVersion(1);
      return res.json(activatedSettings);
    }

    res.json(updatedSettings);
  });

export default handler;
