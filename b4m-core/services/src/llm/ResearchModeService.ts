import { ResearchModeParamsSchema, ModelInfo } from '@bike4mind/common';
import { type ICompletionOptions, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

export interface ResearchModeResult {
  configurationId: string;
  success: boolean;
  response?: string;
  error?: string;
  completionInfo?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class ResearchModeService {
  constructor(
    private apiKeyTable: any,
    private modelInfos: ModelInfo[],
    private logger: Logger,
    // Internal id of the end user this research run is on behalf of, forwarded
    // to direct providers for per-user abuse attribution. See toProviderEndUserId.
    private endUserId?: string
  ) {}

  async processResearchMode(
    researchMode: z.infer<typeof ResearchModeParamsSchema>,
    messages: any[],
    baseOptions: ICompletionOptions,
    onStream: (configId: string, streamedTexts: (string | null | undefined)[], completionInfo?: any) => Promise<void>
  ): Promise<ResearchModeResult[]> {
    if (!researchMode?.enabled || !researchMode.configurations?.length) {
      throw new Error('Research Mode is not properly configured');
    }

    this.logger.info(`🔬 [Research Mode] Processing ${researchMode.configurations.length} configurations`);

    // Filter enabled configurations first
    const enabledConfigs = researchMode.configurations.filter(config => config.enabled);

    // Process all enabled configurations in parallel
    const promises = enabledConfigs.map(config => this.processConfiguration(config, messages, baseOptions, onStream));

    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
      const configId = enabledConfigs[index].id;
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        this.logger.error(`🔬 [Research Mode] Configuration ${configId} failed:`, result.reason);
        return {
          configurationId: configId,
          success: false,
          error: result.reason?.message || 'Unknown error',
        };
      }
    });
  }

  private async processConfiguration(
    config: any,
    messages: any[],
    baseOptions: ICompletionOptions,
    onStream: (configId: string, streamedTexts: (string | null | undefined)[], completionInfo?: any) => Promise<void>
  ): Promise<ResearchModeResult> {
    try {
      this.logger.info(`🔬 [Research Mode] Processing configuration: ${config.label || config.model} (${config.id})`);

      // Get model info for this configuration
      const modelInfo = this.modelInfos.find(m => m.id === config.model);
      if (!modelInfo) {
        throw new Error(`Model ${config.model} not found`);
      }

      // Get LLM instance for this model
      const llm = getLlmByModel(this.apiKeyTable, {
        modelInfo,
        logger: this.logger,
        endUserId: this.endUserId,
      });

      if (!llm) {
        throw new Error(`Failed to get LLM instance for model ${config.model}`);
      }

      // Prepare options with configuration-specific parameters
      const options: ICompletionOptions = {
        ...baseOptions,
        temperature: config.parameters?.temperature ?? baseOptions.temperature,
        maxTokens: config.parameters?.maxTokens ?? baseOptions.maxTokens,
        topP: config.parameters?.topP ?? baseOptions.topP,
        presencePenalty: config.parameters?.presencePenalty ?? baseOptions.presencePenalty,
        frequencyPenalty: config.parameters?.frequencyPenalty ?? baseOptions.frequencyPenalty,
      };

      let finalResponse = '';
      let completionInfo: any = undefined;

      // Create a timeout promise (120 seconds timeout)
      const TIMEOUT_MS = 120000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout after ${TIMEOUT_MS / 1000} seconds`)), TIMEOUT_MS);
      });

      // Race between the LLM completion and timeout
      await Promise.race([
        llm.complete(
          config.model,
          messages,
          options,
          async (streamedTexts: (string | null | undefined)[], info?: any) => {
            // Forward streaming data with configuration ID
            await onStream(config.id, streamedTexts, info);

            // Accumulate response
            if (streamedTexts.some(text => text != null)) {
              finalResponse += streamedTexts.filter(text => text != null).join('');
            }

            if (info) {
              completionInfo = info;
            }
          }
        ),
        timeoutPromise,
      ]);

      this.logger.info(`🔬 [Research Mode] Configuration ${config.id} completed successfully`);

      return {
        configurationId: config.id,
        success: true,
        response: finalResponse,
        completionInfo,
      };
    } catch (error) {
      this.logger.error(`🔬 [Research Mode] Configuration ${config.id} failed:`, error);

      return {
        configurationId: config.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
