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

const CONFIG_TIMEOUT_BASE_MS = 120_000;
const CONFIG_TIMEOUT_CAP_MS = 600_000;
// Slowest sustained output rate a configuration is expected to manage (Opus-class), in tokens/s.
const MIN_OUTPUT_TOKENS_PER_SECOND = 40;
// How long a timed-out configuration's aborted stream may take to stop and report its usage.
const TIMEOUT_DRAIN_MS = 10_000;

/**
 * How long a research configuration may run: a base for time-to-first-token and tool rounds, plus
 * its output budget at the slowest expected rate, capped so a stuck provider still gives up.
 */
export function researchConfigTimeoutMs(maxTokens: number | undefined): number {
  if (!maxTokens || maxTokens < 0) return CONFIG_TIMEOUT_BASE_MS;
  return Math.min(
    CONFIG_TIMEOUT_CAP_MS,
    CONFIG_TIMEOUT_BASE_MS + Math.ceil((maxTokens / MIN_OUTPUT_TOKENS_PER_SECOND) * 1000)
  );
}

// Usage counts only: a timed-out stream's last info can be a mid-stream chunk carrying thinking text.
function reportedUsage(info: { inputTokens?: unknown; outputTokens?: unknown } | undefined) {
  return typeof info?.inputTokens === 'number' && typeof info.outputTokens === 'number'
    ? { inputTokens: info.inputTokens, outputTokens: info.outputTokens }
    : undefined;
}

async function drainCompletion(completion: Promise<unknown>): Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    completion.catch(() => undefined),
    new Promise(resolve => {
      handle = setTimeout(resolve, TIMEOUT_DRAIN_MS);
    }),
  ]);
  clearTimeout(handle);
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
    let completionInfo: any = undefined;
    // Per configuration, so a timeout stops this provider stream without cancelling the quest or siblings.
    const configAbort = new AbortController();
    const onQuestAbort = () => configAbort.abort();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      this.logger.info(`🔬 [Research Mode] Processing configuration: ${config.label || config.model} (${config.id})`);

      // Get model info for this configuration
      const modelInfo = this.modelInfos.find(m => m.id === config.model);
      if (!modelInfo) {
        throw new Error(`Model ${config.model} not found`);
      }
      const reasoningWithholder = withholdsReasoning(thinkingVisibility, config.model)
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

      // Prepare options with configuration-specific parameters
      const options: ICompletionOptions = {
        ...baseOptions,
        temperature: config.parameters?.temperature ?? baseOptions.temperature,
        maxTokens: researchConfigMaxTokens(config.parameters?.maxTokens, baseOptions.maxTokens, modelInfo),
        topP: config.parameters?.topP ?? baseOptions.topP,
        presencePenalty: config.parameters?.presencePenalty ?? baseOptions.presencePenalty,
        frequencyPenalty: config.parameters?.frequencyPenalty ?? baseOptions.frequencyPenalty,
        abortSignal: configAbort.signal,
      };

      const timeoutMs = researchConfigTimeoutMs(options.maxTokens);
      // Settles the race promptly on a Stop or timeout even if the adapter ignores the signal. The
      // race subscribes to it, so a rejection after the race has settled is handled, not unhandled.
      const stopped = new Promise<never>((_, reject) => {
        configAbort.signal.addEventListener(
          'abort',
          () => reject(new Error(timedOut ? `Timeout after ${timeoutMs / 1000} seconds` : 'Cancelled')),
          { once: true }
        );
      });
      abortSignal?.addEventListener('abort', onQuestAbort, { once: true });
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        configAbort.abort();
      }, timeoutMs);

      const completion = llm.complete(
        config.model,
        // Each configuration gets its own copy: backends append their tool rounds in place, in
        // their own provider's shape, and the configurations run in parallel.
        [...messages],
        options,
        async (rawTexts: (string | null | undefined)[], rawInfo?: any) => {
          for (const text of rawTexts) streamedChars += text?.length ?? 0;
          // The configuration already failed; the aborted stream is only drained for its usage.
          if (timedOut) {
            if (rawInfo) completionInfo = rawInfo;
            return;
          }
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
      );

      try {
        await Promise.race([completion, stopped]);
      } catch (error) {
        // The provider keeps reporting until its aborted stream really stops, so wait (bounded) for
        // that to bill what it consumed. A Stop is not drained, so it still returns at once.
        if (timedOut) await drainCompletion(completion);
        throw error;
      }
      const heldText = reasoningWithholder?.flush();
      if (heldText) {
        finalResponse += heldText;
        await onStream(config.id, [heldText]);
      }

      this.logger.info(`🔬 [Research Mode] Configuration ${config.id} completed successfully`);

      return {
        configurationId: config.id,
        model: config.model,
        success: true,
        response: finalResponse,
        streamedChars,
        completionInfo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (timedOut) {
        // A handled outcome, so warn rather than page the error alert path.
        this.logger.warn(`\u{1F52C} [Research Mode] Configuration ${config.id} timed out: ${message}`);
        return {
          configurationId: config.id,
          model: config.model,
          success: false,
          streamedChars,
          error: message,
          completionInfo: reportedUsage(completionInfo),
        };
      }
      this.logger.error(`🔬 [Research Mode] Configuration ${config.id} failed:`, error);

      return {
        configurationId: config.id,
        model: config.model,
        success: false,
        streamedChars,
        error: message,
      };
    } finally {
      clearTimeout(timeoutHandle);
      abortSignal?.removeEventListener('abort', onQuestAbort);
    }
  }
}
