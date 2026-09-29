import { getSettingsByNames } from '@bike4mind/utils';
import {
  buildApiKeyTable,
  getAvailableModels,
  getLlmByModel,
  resolveSuccessorChain,
  type ApiKeyTable,
  type ICompletionBackend,
} from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { apiKeyRepository, adminSettingsRepository, AdminSettings } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import {
  OperationsModelConfig,
  OperationsModelResult,
  getDefaultImageModel,
  getApiKeyTypeFromBackend,
} from '../server/utils/modelResolvers';

/**
 * System-level key table passed to getAvailableModels/getLlmByModel. Aliases the
 * shared ApiKeyTable rather than redeclaring the provider list: the local shape
 * this replaced had drifted a provider behind, so background auto-naming,
 * summaries and research could never reach a newly added backend.
 */
type OperationsApiKeyTable = ApiKeyTable;

/** Text-only operations result: no image/speech resolution. */
export type OperationsTextModelResult = Pick<OperationsModelResult, 'modelId' | 'llm' | 'modelInfo'>;

/**
 * Get effective API key directly from ModelBackend without needing to convert to ApiKeyType first
 * Returns null for backends that don't use API keys (like Bedrock)
 */
export const getEffectiveApiKeyByBackend = async (userId: string, backend: ModelBackend): Promise<string | null> => {
  const apiKeyType = getApiKeyTypeFromBackend(backend);

  if (apiKeyType === null) {
    // Backend doesn't use API keys (e.g., Bedrock uses AWS credentials)
    return null;
  }

  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  return (await apiKeyService.getEffectiveApiKey(userId, { type: apiKeyType }, dbAdapters)) || null;
};

export class OperationsModelService {
  private static logger = new Logger({ metadata: { service: 'OperationsModelService' } });

  /**
   * Self-host operations fallback: pick a local Ollama text model.
   *
   * Background tasks (auto-naming, summaries, research) need a text model even
   * when no cloud key is set. The generic "any text model" fallback would pick a
   * Bedrock model first (getAvailableModels always enumerates Bedrock, ahead of
   * Ollama) which then fails at inference with no AWS credentials. Prefer the
   * operator's primary pull (first token of OLLAMA_PULL_MODELS) so the chat model
   * is chosen over the embedder, else the first available Ollama text model.
   *
   * Returns undefined unless B4M_SELF_HOST is set and a local text model exists,
   * so callers fall through to the unchanged cloud chain.
   */
  private static resolveSelfHostDefaultTextModel(models: ModelInfo[]): ModelInfo | undefined {
    if (process.env.B4M_SELF_HOST !== 'true') return undefined;

    const ollamaTextModels = models.filter(m => m.backend === ModelBackend.Ollama && m.type === 'text');
    if (ollamaTextModels.length === 0) return undefined;

    const firstPull = process.env.OLLAMA_PULL_MODELS?.trim().split(/\s+/)[0];
    const chosen = (firstPull && ollamaTextModels.find(m => m.id === firstPull)) || ollamaTextModels[0];

    this.logger.info(`Self-host: defaulting operations text model to ${chosen.id} (${chosen.backend})`);
    return chosen;
  }

  /** True when a cloud text-model API key is available; gates the self-host Ollama default. */
  private static hasCloudTextKey(apiKeyTable: OperationsApiKeyTable): boolean {
    // Kimi and DeepSeek count: both are hosted text providers, so holding only
    // one of their keys should stop self-host from defaulting operations to
    // local Ollama.
    return !!(
      apiKeyTable.openai ||
      apiKeyTable.anthropic ||
      apiKeyTable.gemini ||
      apiKeyTable.xai ||
      apiKeyTable.kimi ||
      apiKeyTable.deepseek
    );
  }

  /**
   * Shared operations text-model selection chain (no LLM init, no image/speech).
   * Order: self-host local Ollama (only when self-host and no cloud key) ->
   * the preferred model id (admin config or hardcoded default) -> gpt-3.5-turbo ->
   * any available text model. Throws only when no text model exists at all.
   */
  private static pickOperationsTextModelInfo(
    apiKeyTable: OperationsApiKeyTable,
    models: ModelInfo[],
    preferredModelId?: string
  ): ModelInfo {
    let modelInfo = OperationsModelService.hasCloudTextKey(apiKeyTable)
      ? undefined
      : OperationsModelService.resolveSelfHostDefaultTextModel(models);

    if (!modelInfo && preferredModelId) {
      modelInfo = models.find(m => m.id === preferredModelId);
    }
    if (!modelInfo) {
      // gpt-3.5-turbo is a legacy fallback id no longer in the ModelName union; compare as string.
      modelInfo = models.find(m => (m.id as string) === 'gpt-3.5-turbo');
    }
    if (!modelInfo) {
      modelInfo = OperationsModelService.pickAnyTextModel(models);
    }
    if (!modelInfo) {
      throw new Error('No text models available for operations');
    }
    return modelInfo;
  }

  /**
   * Last-resort pick: the first text model, walked to its successor when the caller can run it.
   * Bedrock enumerates legacy ids first, and AWS denies a Legacy model outright to an account
   * that has not invoked it in 30 days. resolveSuccessorChain, not resolveDeprecatedModelId:
   * this is our own fallback, not a pinned request, so it must not count toward [model-sunset].
   */
  private static pickAnyTextModel(models: ModelInfo[]): ModelInfo | undefined {
    const first = models.find(m => m.type === 'text');
    if (!first) return undefined;

    const successorId = resolveSuccessorChain(first.id);
    if (successorId === first.id) return first;

    const successor = models.find(m => m.id === successorId);
    if (!successor) {
      this.logger.warn(
        `Operations fallback ${first.id} is superseded and its successor ${successorId} is unavailable; keeping it`
      );
      return first;
    }
    this.logger.info(`Operations fallback ${first.id} is superseded; using its successor ${successorId}`);
    return successor;
  }

  /**
   * Build a usable image backend starting from `candidate`, retrying down
   * getDefaultImageModel's priority order when a candidate's backend fails to
   * construct (e.g. a local-image model whose server is currently
   * unreachable). Returns `{ undefined, null }` once every image model in the
   * catalog has been tried and none could build.
   */
  private static pickWorkingImageModel(
    apiKeyTable: OperationsApiKeyTable,
    models: ModelInfo[],
    candidate: ModelInfo | undefined,
    logLabel: string
  ): { imageModelInfo: ModelInfo | undefined; imageLlm: ICompletionBackend | null } {
    const tried = new Set<string>();
    let next = candidate;

    while (next && !tried.has(next.id)) {
      tried.add(next.id);
      let llm: ICompletionBackend | null = null;
      try {
        llm = getLlmByModel(apiKeyTable, { modelInfo: next, logger: this.logger });
      } catch (err) {
        this.logger.warn(`Failed to initialize ${logLabel} image model ${next.id}`, err);
      }
      if (llm) {
        return { imageModelInfo: next, imageLlm: llm };
      }

      this.logger.warn(
        `Failed to initialize ${logLabel} image model ${next.id} - trying the next available image model`
      );
      next = getDefaultImageModel(models, tried);
    }

    this.logger.warn(`No usable image models available for ${logLabel} - continuing without image support`);
    return { imageModelInfo: undefined, imageLlm: null };
  }

  /**
   * Resolve ONLY the operations text model and its LLM - never image or speech.
   *
   * Background tasks (research, summaries) need a text model and must not fail when
   * no image/speech model is configured or available, unlike getOperationsModel which
   * resolves all three. Uses the same text-selection chain (self-host Ollama default
   * -> admin-configured model -> cloud fallbacks).
   */
  static async getOperationsTextModel(): Promise<OperationsTextModelResult> {
    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
    const apiKeyTable = buildApiKeyTable(coreKeys);
    const models = await getAvailableModels(apiKeyTable);

    // Prefer the admin-configured operations model; else the hardcoded default id.
    const config = await this.getOperationsModelConfig();
    const modelInfo = OperationsModelService.pickOperationsTextModelInfo(
      apiKeyTable,
      models,
      config?.modelId ?? 'gpt-4o-mini'
    );

    const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: this.logger });
    if (!llm) {
      throw new Error(`Failed to initialize operations text model ${modelInfo.id}`);
    }

    this.logger.info(`Using operations text model: ${modelInfo.id} (${modelInfo.backend})`);
    return { modelId: modelInfo.id, llm, modelInfo };
  }

  /**
   * Get the configured operations model and initialize LLM
   */
  static async getOperationsModel(): Promise<OperationsModelResult> {
    try {
      let setting;
      try {
        setting = await Promise.race([
          AdminSettings.findOne({
            settingName: 'operationsModel',
          })
            .lean()
            .exec(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Database timeout')), 5000)),
        ]);
      } catch (dbError) {
        this.logger.warn('Database timeout getting operations model setting, using hardcoded default');
        return await this.getHardcodedDefaultOperationsModel();
      }

      if (!setting) {
        this.logger.warn('Operations model not configured, using default');
        return await this.getDefaultOperationsModel();
      }

      const config = (setting as any).settingValue as unknown as OperationsModelConfig;

      // Resolve available models using the system-level API keys
      const dbAdapters = {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      };
      const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
      const apiKeyTable = buildApiKeyTable(coreKeys);
      const models = await getAvailableModels(apiKeyTable);

      const modelInfo = models.find(m => m.id === config.modelId);

      if (!modelInfo) {
        this.logger.error(`Operations model ${config.modelId} not available, using default`);
        return await this.getDefaultOperationsModel();
      }

      const llm = getLlmByModel(apiKeyTable, {
        modelInfo,
        logger: this.logger,
      });

      if (!llm) {
        this.logger.error(`Failed to initialize LLM for operations model ${modelInfo.id}`);
        throw new Error(`Failed to initialize operations model ${modelInfo.id}`);
      }

      let imageModelInfo = models.find(m => m.id === config.imageModelId);

      if (!imageModelInfo) {
        this.logger.warn(
          `Configured image model ${config.imageModelId} not available (possibly deprecated), falling back to default`
        );
        imageModelInfo = getDefaultImageModel(models);
      }

      // Image model is optional - a deployment with no configured image backend
      // (e.g. self-host with no BFL/OpenAI/local-image key) has none, and
      // text-only operations callers must not fail on that account.
      const imagePick = OperationsModelService.pickWorkingImageModel(apiKeyTable, models, imageModelInfo, 'operations');
      imageModelInfo = imagePick.imageModelInfo;
      const imageLlm = imagePick.imageLlm;

      // Speech model is optional - proceed without it if unavailable
      const speechModelInfo = models.find(m => m.id === config.speechModelId);
      let speechLlm = null;

      if (!speechModelInfo) {
        this.logger.warn(`Speech model ${config.speechModelId} not available - continuing without speech support`);
      } else {
        speechLlm = getLlmByModel(apiKeyTable, {
          modelInfo: speechModelInfo,
          logger: this.logger,
        });

        if (!speechLlm) {
          this.logger.warn(
            `Failed to initialize LLM for operations speech model ${config.speechModelId} - continuing without speech support`
          );
          speechLlm = null;
        }
      }

      return {
        modelId: modelInfo.id,
        llm,
        modelInfo,
        imageLlm,
        imageModelId: imageModelInfo ? imageModelInfo.id : null,
        imageModelInfo: imageModelInfo || null,
        speechLlm,
        speechModelId: speechModelInfo ? speechModelInfo.id : null,
        speechModelInfo: speechModelInfo || null,
      };
    } catch (error) {
      this.logger.error('Error getting operations model:', error);
      // If all else fails, try hardcoded default without database
      return await this.getHardcodedDefaultOperationsModel();
    }
  }

  /**
   * Get hardcoded default operations model (no database access)
   */
  private static async getHardcodedDefaultOperationsModel(): Promise<OperationsModelResult> {
    const defaultConfig: OperationsModelConfig = {
      modelId: 'gpt-4o-mini',
      imageModelId: 'flux-pro-1.1',
      speechModelId: 'whisper-1',
    };

    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
    const apiKeyTable = buildApiKeyTable(coreKeys);
    const models = await getAvailableModels(apiKeyTable);

    const modelInfo = OperationsModelService.pickOperationsTextModelInfo(apiKeyTable, models, defaultConfig.modelId);

    const llm = getLlmByModel(apiKeyTable, {
      modelInfo,
      logger: this.logger,
    });

    if (!llm) {
      throw new Error(`Failed to initialize hardcoded default operations model ${modelInfo.id}`);
    }

    this.logger.info(`Using hardcoded default operations model: ${modelInfo.id} (${modelInfo.backend})`);

    let imageModelInfo = models.find(m => m.id === defaultConfig.imageModelId);

    if (!imageModelInfo) {
      imageModelInfo = getDefaultImageModel(models);
    }

    // Image model is optional - see getOperationsModel's comment.
    const imagePick = OperationsModelService.pickWorkingImageModel(
      apiKeyTable,
      models,
      imageModelInfo,
      'hardcoded default operations'
    );
    imageModelInfo = imagePick.imageModelInfo;
    const imageLlm = imagePick.imageLlm;
    if (imageModelInfo) {
      this.logger.info(
        `Using hardcoded default operations image model: ${imageModelInfo.id} (${imageModelInfo.backend})`
      );
    }

    // Speech model is optional
    let speechModelInfo = models.find(m => m.id === defaultConfig.speechModelId);
    let speechLlm = null;

    if (!speechModelInfo) {
      speechModelInfo = models.find(m => m.type === 'speech-to-text');
    }

    if (!speechModelInfo) {
      this.logger.warn('No speech models available for operations - continuing without speech support');
    } else {
      speechLlm = getLlmByModel(apiKeyTable, {
        modelInfo: speechModelInfo,
        logger: this.logger,
      });

      if (!speechLlm) {
        this.logger.warn(
          `Failed to initialize hardcoded default operations speech model ${speechModelInfo.id} - continuing without speech support`
        );
        speechLlm = null;
      } else {
        this.logger.info(
          `Using hardcoded default operations speech model: ${speechModelInfo.id} (${speechModelInfo.backend})`
        );
      }
    }

    return {
      modelId: modelInfo.id,
      llm,
      modelInfo,
      imageModelId: imageModelInfo ? imageModelInfo.id : null,
      imageModelInfo: imageModelInfo || null,
      imageLlm,
      speechModelId: speechModelInfo ? speechModelInfo.id : null,
      speechModelInfo: speechModelInfo || null,
      speechLlm,
    };
  }

  /**
   * Get default operations model when configuration is missing
   */
  private static async getDefaultOperationsModel(): Promise<OperationsModelResult> {
    const defaultConfig: OperationsModelConfig = {
      modelId: 'gpt-4o-mini',
      imageModelId: 'flux-pro-1.1',
      speechModelId: 'whisper-1',
    };

    // Seed the default setting, but don't fail if database is unavailable. $setOnInsert:
    // this also runs when a configured model is merely unavailable here (e.g. no key for its
    // backend), and that must not overwrite the admin's choice.
    try {
      await AdminSettings.findOneAndUpdate(
        { settingName: 'operationsModel' },
        {
          $setOnInsert: {
            settingName: 'operationsModel',
            settingValue: defaultConfig,
          },
        },
        { upsert: true }
      );
    } catch (error) {
      this.logger.warn('Could not save default operations model setting to database:', error);
    }

    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
    const apiKeyTable = buildApiKeyTable(coreKeys);
    const models = await getAvailableModels(apiKeyTable);

    const modelInfo = OperationsModelService.pickOperationsTextModelInfo(apiKeyTable, models, defaultConfig.modelId);

    const llm = getLlmByModel(apiKeyTable, {
      modelInfo,
      logger: this.logger,
    });

    if (!llm) {
      throw new Error(`Failed to initialize default operations model ${modelInfo.id}`);
    }

    this.logger.info(`Using default operations model: ${modelInfo.id} (${modelInfo.backend})`);

    let imageModelInfo = getDefaultImageModel(models);

    // Image model is optional - see getOperationsModel's comment.
    const imagePick = OperationsModelService.pickWorkingImageModel(
      apiKeyTable,
      models,
      imageModelInfo,
      'default operations'
    );
    imageModelInfo = imagePick.imageModelInfo;
    const imageLlm = imagePick.imageLlm;
    if (imageModelInfo) {
      this.logger.info(`Using default image model: ${imageModelInfo.id} (${imageModelInfo.backend})`);
    }

    // Speech model is optional
    const speechModelInfo = models.find(m => m.id === defaultConfig.speechModelId);
    let speechLlm = null;

    if (!speechModelInfo) {
      this.logger.warn('No speech models available for operations - continuing without speech support');
    } else {
      speechLlm = getLlmByModel(apiKeyTable, {
        modelInfo: speechModelInfo,
        logger: this.logger,
      });

      if (!speechLlm) {
        this.logger.warn(
          `Failed to initialize default operations speech model ${speechModelInfo.id} - continuing without speech support`
        );
        speechLlm = null;
      } else {
        this.logger.info(`Using default speech model: ${speechModelInfo.id} (${speechModelInfo.backend})`);
      }
    }

    return {
      modelId: modelInfo.id,
      llm,
      modelInfo,
      imageLlm,
      imageModelId: imageModelInfo ? imageModelInfo.id : null,
      imageModelInfo: imageModelInfo || null,
      speechLlm,
      speechModelId: speechModelInfo ? speechModelInfo.id : null,
      speechModelInfo: speechModelInfo || null,
    };
  }

  /**
   * Update the operations model configuration
   */
  static async updateOperationsModel(config: OperationsModelConfig): Promise<void> {
    try {
      await AdminSettings.findOneAndUpdate(
        { settingName: 'operationsModel' },
        {
          settingName: 'operationsModel',
          settingValue: config,
        },
        { upsert: true }
      );

      this.logger.info(`Updated operations model configuration:`, config);
    } catch (error) {
      this.logger.error('Error updating operations model:', error);
      throw new Error('Failed to update operations model configuration');
    }
  }

  /**
   * Get current operations model configuration
   */
  static async getOperationsModelConfig(): Promise<OperationsModelConfig | null> {
    try {
      const setting = await AdminSettings.findOne({
        settingName: 'operationsModel',
      });

      return setting ? (setting.settingValue as unknown as OperationsModelConfig) : null;
    } catch (error) {
      this.logger.error('Error getting operations model config:', error);
      return null;
    }
  }
}
