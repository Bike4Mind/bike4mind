import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { ForbiddenError, BadRequestError, InternalServerError, getSettingsByNames } from '@bike4mind/utils';
import { agentOpsModelRejection } from '@client/app/utils/agentOpsModels';
import { modelCatalogListingOptions } from '@client/server/utils/modelCatalogOptions';

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
 * the picker in AgentOpsTab reads the same catalog through /api/models, so a label cannot go
 * stale and a newly added model is selectable the day it ships. The listing options come from
 * the shared helper so both sides land in the same getAvailableModels cache slot.
 *
 * Keys are resolved with no user id, i.e. admin/demo keys only. AgentOpsSettings is a single
 * global document consumed under other users' identities, so its validity must not depend on
 * which admin happened to save it or on a personal key only that admin holds. The picker stays
 * user-scoped, so an admin can see a model backed solely by their own key; refusing to pin it
 * is the intended answer for a global setting.
 *
 * Deprecated ids are absent because getAvailableModels drops them, and pinning a retired model
 * is a new write nobody needs. A document already pinned to one misses the catalog lookup in
 * generate-system-prompt / create-from-context and falls back to the default model there.
 */
async function fetchSelectableModels() {
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(null, dbAdapters);
  return getAvailableModels(buildApiKeyTable(coreKeys), modelCatalogListingOptions());
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

    // Only a change of pin is worth a live catalog fan-out: validating on every save would let a
    // slow backend fail an isEnabled- or rateLimitSeconds-only edit, blaming a field the admin
    // never touched. A model already stored stays valid until someone tries to change it.
    const current = await agentOpsSettingsRepository.getSettings();
    if (generationLlmModel && generationLlmModel !== current?.generationLlmModel) {
      const models = await fetchSelectableModels();
      // An empty catalog means every backend listing failed; rejecting the save would read as
      // "bad model" when the model is fine, so fail loudly instead of blaming the input.
      if (models.length === 0) {
        throw new InternalServerError('Model catalog is unavailable; try again shortly');
      }
      const rejection = agentOpsModelRejection(models, generationLlmModel);
      if (rejection) {
        throw new BadRequestError(rejection);
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
