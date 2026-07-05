import { Request, Response } from 'express';
import { ApiKeyType, IMessage } from '@bike4mind/common';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { baseApi } from '@server/middlewares/baseApi';
import { AdminSettings, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';

const handler = baseApi().post(async (req: Request, res: Response) => {
  const { model, prompt, stream } = req.body as Record<string, string>;
  const settings = await AdminSettings.find({ settingName: { $in: ['EnableOllama', 'ollamaBackend'] } });
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } };
  const userIdForService = req.user?.id || 'system';
  const apiKeyTable = {
    openai:
      (await apiKeyService.getEffectiveApiKey(userIdForService, { type: ApiKeyType.openai }, dbAdapters)) || undefined,
    anthropic:
      (await apiKeyService.getEffectiveApiKey(userIdForService, { type: ApiKeyType.anthropic }, dbAdapters)) ||
      undefined,
    gemini:
      (await apiKeyService.getEffectiveApiKey(userIdForService, { type: ApiKeyType.gemini }, dbAdapters)) || undefined,
    bfl: (await apiKeyService.getEffectiveApiKey(userIdForService, { type: ApiKeyType.bfl }, dbAdapters)) || undefined,
    ollama:
      (settings.find(s => s.settingName === 'EnableOllama')?.settingValue.toString() === 'true' &&
        settings.find(s => s.settingName === 'ollamaBackend')?.settingValue) ||
      undefined,
  };
  const models = await getAvailableModels(apiKeyTable);
  const modelInfo = models.find(m => m.id === model);

  // TODO: this getLlmByModel internally uses Config for Anthropic/Gemini keys, so we
  // only pass the OpenAI key here. The @bike4mind copy of getLlmByModel doesn't do
  // this - the two implementations should be unified.
  const llm = getLlmByModel(apiKeyTable, {
    modelInfo,
    logger: req.logger,
    endUserId: req.user?.id,
  });
  if (!llm) {
    throw new Error('Invalid LLM backend specified');
  }
  const messages: IMessage[] = [
    {
      role: 'user',
      content: prompt,
    },
  ];

  try {
    let result: string = '';
    await llm.complete(
      model,
      messages,
      { stream: modelInfo?.can_stream && stream.toString() === 'true' },
      async text => {
        result = result.concat(text[0] ?? '');
      }
    );
    return res.json({ result });
  } catch (error: unknown) {
    return res.status(500).json({
      ...(error as Error),
      message: (error as Error).message,
    });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
