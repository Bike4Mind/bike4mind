import {
  ResearchModeParamsSchema,
  ModelInfo,
  createReasoningWithholder,
  reasoningChannelOf,
  withholdsReasoning,
  type ThinkingVisibility,
} from '@bike4mind/common';
import { type ICompletionOptions, getLlmByModel, resolveOutputMaxTokens } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { DEFAULT_OUTPUT_MAX_TOKENS } from '@bike4mind/utils';
import { z } from 'zod';

export interface ResearchModeResult {
  configurationId: string;
  /** The configuration's model, which its usage is priced on. */
  model: string;
  success: boolean;
  /** Characters streamed before the configuration finished or failed, to price an interrupted run. */
  streamedChars: number;
  response?: string;
  error?: string;
  completionInfo?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * The output ceiling a research configuration runs with: its own requested maxTokens (else the
 * turn's), clamped to its model's cap. ChatCompletionProcess reserves credits on this same value,
 * so the hold and what each configuration may spend agree.
 */
export function researchConfigMaxTokens(
  requested: number | undefined,
  baseMaxTokens: number | undefined,
  modelInfo: ModelInfo
): number {
  return resolveOutputMaxTokens({
    requested: requested ?? baseMaxTokens,
    fallback: DEFAULT_OUTPUT_MAX_TOKENS,
    modelInfo,
    modelMaxOutputTokens: modelInfo.max_tokens,
  });
}

export class ResearchModeService {
  constructor(
    private apiKeyTable: any,
    private modelInfos: ModelInfo[],
    private logger: Logger,
    // Internal id of the end user this research run is on behalf of, forwarded
    // to direct providers for per-user abuse attribution. See toProviderEndUserId.
    private endUserId?: string,
    // The model each configuration actually runs on; results keep reporting the configured id.
    private runModelFor?: (requested: ModelInfo) => ModelInfo
  ) {}

  async processResearchMode(
    researchMode: z.infer<typeof ResearchModeParamsSchema>,
    messages: any[],
    baseOptions: ICompletionOptions,
    onStream: (configId: string, streamedTexts: (string | null | undefined)[], completionInfo?: any) => Promise<void>,
    abortSignal?: AbortSignal,
    thinkingVisibility: ThinkingVisibility = 'raw'
  ): Promise<ResearchModeResult[]> {
    if (!researchMode?.enabled || !researchMode.configurations?.length) {
      throw new Error('Research Mode is not properly configured');
    }

    this.logger.info(`🔬 [Research Mode] Processing ${researchMode.configurations.length} configurations`);

    // Filter enabled configurations first
    const enabledConfigs = researchMode.configurations.filter(config => config.enabled);

    // Process all enabled configurations in parallel
    const promises = enabledConfigs.map(config =>
      this.processConfiguration(config, messages, baseOptions, onStream, abortSignal, thinkingVisibility)
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
      const configId = enabledConfigs[index].id;
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        this.logger.error(`🔬 [Research Mode] Configuration ${configId} failed:`, result.reason);
        return {
          configurationId: configId,
          model: enabledConfigs[index].model,
          success: false,
          streamedChars: 0,
          error: result.reason?.message || 'Unknown error',
        };
      }
    });
  }

  private async processConfiguration(
    config: any,
    messages: any[],
    baseOptions: ICompletionOptions,
    onStream: (configId: string, streamedTexts: (string | null | undefined)[], completionInfo?: any) => Promise<void>,
    abortSignal?: AbortSignal,
    thinkingVisibility: ThinkingVisibility = 'raw'
  ): Promise<ResearchModeResult> {
    // A Stop that landed before this configuration started must not reach the provider at all.
    if (abortSignal?.aborted) {
      return { configurationId: config.id, model: config.model, success: false, streamedChars: 0, error: 'Cancelled' };
    }

    // Kept outside the try so a configuration that fails mid-stream still reports what it streamed.
    let finalResponse = '';
    // Billed on what streamed, withheld reasoning included.
    let streamedChars = 0;
    try {
      this.logger.info(`🔬 [Research Mode] Processing configuration: ${config.label || config.model} (${config.id})`);

      // Get model info for this configuration
      const requestedModelInfo = this.modelInfos.find(m => m.id === config.model);
      if (!requestedModelInfo) {
        throw new Error(`Model ${config.model} not found`);
      }
      const modelInfo = this.runModelFor?.(requestedModelInfo) ?? requestedModelInfo;
      const reasoningWithholder = withholdsReasoning(thinkingVisibility, modelInfo.id)
        ? createReasoningWithholder(reasoningChannelOf(modelInfo))
        : null;

      // Get LLM instance for this model
      const llm = getLlmByModel(this.apiKeyTable, {
        modelInfo,
        logger: this.logger,
        endUserId: this.endUserId,
      });

      if (!llm) {
        throw new Error(`Failed to get LLM instance for model ${config.model}`);
      }

      // Prepare options with configuration-specific parameters. Only set abortSignal when the
      // caller supplied one, so the uncancelled path sends exactly the options it did before.
      const options: ICompletionOptions = {
        ...baseOptions,
        temperature: config.parameters?.temperature ?? baseOptions.temperature,
        maxTokens: researchConfigMaxTokens(config.parameters?.maxTokens, baseOptions.maxTokens, modelInfo),
        topP: config.parameters?.topP ?? baseOptions.topP,
        presencePenalty: config.parameters?.presencePenalty ?? baseOptions.presencePenalty,
        frequencyPenalty: config.parameters?.frequencyPenalty ?? baseOptions.frequencyPenalty,
        ...(abortSignal ? { abortSignal } : {}),
        ...(modelInfo.id !== requestedModelInfo.id
          ? { modelIdentityId: requestedModelInfo.id, modelDisplayName: requestedModelInfo.name }
          : {}),
      };

      let completionInfo: any = undefined;

      // Create a timeout promise (120 seconds timeout)
      const TIMEOUT_MS = 120000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Timeout after ${TIMEOUT_MS / 1000} seconds`)), TIMEOUT_MS);
      });

      // Reject promptly on abort too, so a Stop unblocks this configuration even if the
      // adapter ignores the signal. The race subscribes to this promise, so a rejection
      // after the race has already settled is handled and does not surface as unhandled.
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        if (!abortSignal) return;
        onAbort = () => reject(new Error('Cancelled'));
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });

      try {
        // Race between the LLM completion, the timeout, and cancellation
        await Promise.race([
          llm.complete(
            modelInfo.id,
            // Each configuration gets its own copy: backends append their tool rounds in place, in
            // their own provider's shape, and the configurations run in parallel.
            [...messages],
            options,
            async (rawTexts: (string | null | undefined)[], rawInfo?: any) => {
              for (const text of rawTexts) streamedChars += text?.length ?? 0;
              const streamedTexts = reasoningWithholder
                ? rawTexts.map(text => (text ? reasoningWithholder.visible(text, rawInfo?.channel) : text))
                : rawTexts;
              // Research mode runs its own tool loop, so no thinking block needs to reach the client.
              const info = reasoningWithholder && rawInfo?.thinking ? { ...rawInfo, thinking: undefined } : rawInfo;

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
          abortPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (abortSignal && onAbort) abortSignal.removeEventListener('abort', onAbort);
      }
      const heldText = reasoningWithholder?.flush();
      if (heldText) {
        finalResponse += heldText;
        await onStream(config.id, [heldText]);
      }

      this.logger.info(`🔬 [Research Mode] Configuration ${config.id} completed successfully`);

      // Prices at the requested model on substituted runs (overcharging reveals less than undercharging).
      // Chat and agent settlement still bill the model that ran; keep these in step when that changes.
      return {
        configurationId: config.id,
        model: config.model,
        success: true,
        response: finalResponse,
        streamedChars,
        completionInfo,
      };
    } catch (error) {
      this.logger.error(`🔬 [Research Mode] Configuration ${config.id} failed:`, error);

      return {
        configurationId: config.id,
        model: config.model,
        success: false,
        streamedChars,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
