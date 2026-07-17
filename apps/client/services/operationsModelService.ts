import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
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
  private static hasCloudTextKey(apiKeyTable: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
    xai?: string;
  }): boolean {
    return !!(apiKeyTable.openai || apiKeyTable.anthropic || apiKeyTable.gemini || apiKeyTable.xai);
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
      const apiKeyTable = {
        openai: coreKeys.openai || undefined,
        anthropic: coreKeys.anthropic || undefined,
        gemini: coreKeys.gemini || undefined,
        bfl: coreKeys.bfl || undefined,
        ollama: coreKeys.ollama || undefined,
        xai: coreKeys.xai || undefined,
      };
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

      if (!imageModelInfo) {
        throw new Error(`No image models available for operations`);
      }

      const imageLlm = getLlmByModel(apiKeyTable, {
        modelInfo: imageModelInfo,
        logger: this.logger,
      });

      if (!imageLlm) {
        this.logger.error(`Failed to initialize LLM for operations image model ${config.imageModelId}`);
        throw new Error(`Failed to initialize operations image model ${config.imageModelId}`);
      }

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
        imageModelId: imageModelInfo.id,
        imageModelInfo,
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
    const apiKeyTable = {
      openai: coreKeys.openai || undefined,
      anthropic: coreKeys.anthropic || undefined,
      gemini: coreKeys.gemini || undefined,
      bfl: coreKeys.bfl || undefined,
      ollama: coreKeys.ollama || undefined,
      xai: coreKeys.xai || undefined,
    };
    const models = await getAvailableModels(apiKeyTable);

    // Self-host with no cloud key: prefer a local Ollama text model before the cloud chain.
    let modelInfo = OperationsModelService.hasCloudTextKey(apiKeyTable)
      ? undefined
      : OperationsModelService.resolveSelfHostDefaultTextModel(models);

    if (!modelInfo) {
      modelInfo = models.find(m => m.id === defaultConfig.modelId);
    }

    if (!modelInfo) {
      // Fall back to gpt-3.5-turbo
      modelInfo = models.find(m => m.id === ('gpt-3.5-turbo' as any));
    }

    if (!modelInfo) {
      // Last resort: any available text model
      modelInfo = models.find(m => m.type === 'text');
      if (!modelInfo) {
        throw new Error('No text models available for operations');
      }
    }

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

    if (!imageModelInfo) {
      throw new Error('No image models available for operations');
    }

    const imageLlm = getLlmByModel(apiKeyTable, {
      modelInfo: imageModelInfo,
      logger: this.logger,
    });

    if (!imageLlm) {
      throw new Error(`Failed to initialize hardcoded default operations image model ${imageModelInfo.id}`);
    }

    this.logger.info(
      `Using hardcoded default operations image model: ${imageModelInfo.id} (${imageModelInfo.backend})`
    );

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
      imageModelId: imageModelInfo.id,
      imageModelInfo: imageModelInfo,
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

    // Try to seed the default setting, but don't fail if database is unavailable
    try {
      await AdminSettings.findOneAndUpdate(
        { settingName: 'operationsModel' },
        {
          settingName: 'operationsModel',
          settingValue: defaultConfig,
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
    const apiKeyTable = {
      openai: coreKeys.openai || undefined,
      anthropic: coreKeys.anthropic || undefined,
      gemini: coreKeys.gemini || undefined,
      bfl: coreKeys.bfl || undefined,
      ollama: coreKeys.ollama || undefined,
      xai: coreKeys.xai || undefined,
    };
    const models = await getAvailableModels(apiKeyTable);

    // Self-host with no cloud key: prefer a local Ollama text model before the cloud chain.
    let modelInfo = OperationsModelService.hasCloudTextKey(apiKeyTable)
      ? undefined
      : OperationsModelService.resolveSelfHostDefaultTextModel(models);

    if (!modelInfo) {
      modelInfo = models.find(m => m.id === defaultConfig.modelId);
    }

    if (!modelInfo) {
      // Fall back to gpt-3.5-turbo
      modelInfo = models.find(m => m.id === ('gpt-3.5-turbo' as any));
    }

    if (!modelInfo) {
      // Last resort: any available text model
      modelInfo = models.find(m => m.type === 'text');
      if (!modelInfo) {
        throw new Error('No text models available for operations');
      }
    }

    const llm = getLlmByModel(apiKeyTable, {
      modelInfo,
      logger: this.logger,
    });

    if (!llm) {
      throw new Error(`Failed to initialize default operations model ${modelInfo.id}`);
    }

    this.logger.info(`Using default operations model: ${modelInfo.id} (${modelInfo.backend})`);

    const imageModelInfo = getDefaultImageModel(models);
    const imageModelId = imageModelInfo?.id;

    if (imageModelInfo) {
      this.logger.info(`Using default image model: ${imageModelId} (${imageModelInfo.backend})`);
    }

    if (!imageModelInfo) {
      throw new Error('No image models available for operations');
    }

    const imageLlm = getLlmByModel(apiKeyTable, {
      modelInfo: imageModelInfo,
      logger: this.logger,
    });

    if (!imageLlm) {
      throw new Error(`Failed to initialize default operations image model ${imageModelInfo.id}`);
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
      imageModelId: imageModelInfo.id,
      imageModelInfo,
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
