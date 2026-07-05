import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { ForbiddenError, BadRequestError } from '@bike4mind/utils';

interface CreateUpdateSettingsRequest {
  generationLlmModel?: string;
  rateLimitSeconds?: number;
  isEnabled?: boolean;
}

interface AddVersionRequest {
  metaPrompt: string;
  description: string;
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
      const validModels = [
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-opus-4-20250514',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'o3-2025-04-16',
        'gpt-4.1-2025-04-14',
        'grok-3',
        'gpt-4o',
        'gpt-4o-mini',
      ];
      if (!validModels.includes(generationLlmModel)) {
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
