import { Anthropic } from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { MessageBatchResult } from '@anthropic-ai/sdk/resources/messages/batches';
import { Logger } from '@bike4mind/observability';
import { withRetry, isRetryableError } from '@bike4mind/common';

/**
 * Lean, single-shot Anthropic Message Batches client.
 *
 * This is deliberately separate from `AnthropicBackend` (the streaming
 * `ICompletionBackend`). Batches are async, non-streaming, tool-less,
 * single-shot inference - they don't fit the streaming callback contract,
 * and they run on Anthropic's **separate batch rate-limit pool**, so they
 * must NOT go through `_anthropicSemaphore` (which governs the interactive
 * pool). Keeping this isolated keeps both concerns simple.
 *
 * Used by the `/api/transforms/batch` endpoint to route latency-tolerant
 * transforms (BedrockNews's bulk daily/weekly ingest stream) through the
 * Batch API for ~50% token savings + interactive-pool isolation.
 */

/** One transform request as submitted by a batch consumer (e.g. BedrockNews). */
export interface BatchTransformRequest {
  /** Consumer-side correlation id (e.g. BedrockNews articleId). Echoed back in results. */
  clientRef: string;
  model: string;
  maxTokens: number;
  /** Fully-formed system prompt (consumer assembles it - we pass it through verbatim). */
  system?: string;
  messages: MessageParam[];
}

/** Maps the safe Anthropic `custom_id` we generate back to the consumer's `clientRef`. */
export interface CustomIdMapping {
  customId: string;
  clientRef: string;
}

export interface BatchSubmitResult {
  anthropicBatchId: string;
  /** Persist this - `getBatchResults` needs it to translate custom_id -> clientRef. */
  customIdMap: CustomIdMapping[];
}

export interface BatchItemResult {
  clientRef: string;
  status: 'done' | 'failed';
  /** Concatenated text content when `status === "done"`. */
  reply?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** Reason when `status === "failed"` (error / canceled / expired). */
  error?: string;
}

export interface BatchStatus {
  /** Mirrors Anthropic's `processing_status`. Results are only meaningful once `ended`. */
  processingStatus: 'in_progress' | 'canceling' | 'ended';
  counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  /** Present only when `processingStatus === "ended"`. */
  results?: BatchItemResult[];
}

const RETRY_OPTS = (logger: Logger) => ({
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterFactor: 0.25,
  isRetryable: isRetryableError,
  logger,
});

export class AnthropicBatchService {
  private logger: Logger;

  constructor(
    private readonly api: Anthropic,
    logger?: Logger
  ) {
    this.logger = logger ?? new Logger();
  }

  /**
   * Build a service from a raw API key, mirroring `AnthropicBackend`'s
   * transport-level retry wrapper (TLS "terminated" errors bypass the SDK's
   * own HTTP retry).
   */
  static fromApiKey(apiKey: string, logger?: Logger): AnthropicBatchService {
    const log = logger ?? new Logger();
    const retryFetch: typeof fetch = async (input, init) => {
      const MAX_TRANSPORT_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
        try {
          return await fetch(input, init);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          const isTransportError = err instanceof TypeError && (msg === 'terminated' || msg === 'fetch failed');
          if (!isTransportError || attempt === MAX_TRANSPORT_RETRIES) throw err;
          log.warn(`[AnthropicBatchService] Transport error "${msg}", retry ${attempt + 1}/${MAX_TRANSPORT_RETRIES}`);
          await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
        }
      }
      throw new TypeError('terminated');
    };
    const api = new Anthropic({ apiKey, maxRetries: 5, fetch: retryFetch });
    return new AnthropicBatchService(api, log);
  }

  /**
   * Submit a batch. We generate sequential, spec-safe `custom_id`s
   * (`req_<n>`) because consumer `clientRef`s (article ids / URLs) routinely
   * violate Anthropic's `^[a-zA-Z0-9_-]{1,64}$` constraint. The returned
   * `customIdMap` must be persisted so results can be matched back.
   */
  async submitBatch(requests: BatchTransformRequest[]): Promise<BatchSubmitResult> {
    if (!requests.length) {
      throw new Error('[AnthropicBatchService] submitBatch called with no requests');
    }

    const customIdMap: CustomIdMapping[] = requests.map((r, i) => ({
      customId: `req_${i}`,
      clientRef: r.clientRef,
    }));

    const apiRequests = requests.map((r, i) => {
      const params: MessageCreateParamsNonStreaming = {
        model: r.model,
        max_tokens: r.maxTokens,
        messages: r.messages,
        ...(r.system ? { system: r.system } : {}),
      };
      return { custom_id: `req_${i}`, params };
    });

    const batch = await withRetry(
      () => this.api.messages.batches.create({ requests: apiRequests }),
      RETRY_OPTS(this.logger)
    ).then(r => r.result);

    this.logger.info(`[AnthropicBatchService] Submitted batch ${batch.id} with ${requests.length} request(s)`);

    return { anthropicBatchId: batch.id, customIdMap };
  }

  /**
   * Poll a batch. While `in_progress`/`canceling`, returns status only.
   * Once `ended`, streams the `.jsonl` results and maps each `custom_id`
   * back to its `clientRef` via the supplied map.
   */
  async getBatchResults(anthropicBatchId: string, customIdMap: CustomIdMapping[]): Promise<BatchStatus> {
    const batch = await withRetry(
      () => this.api.messages.batches.retrieve(anthropicBatchId),
      RETRY_OPTS(this.logger)
    ).then(r => r.result);

    const counts = {
      processing: batch.request_counts.processing,
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      canceled: batch.request_counts.canceled,
      expired: batch.request_counts.expired,
    };

    if (batch.processing_status !== 'ended') {
      return { processingStatus: batch.processing_status, counts };
    }

    const refByCustomId = new Map(customIdMap.map(m => [m.customId, m.clientRef]));
    const results: BatchItemResult[] = [];

    // `results()` returns a JSONL decoder - an async iterable of per-request
    // responses. Order is not guaranteed; we match on custom_id.
    const stream = await this.api.messages.batches.results(anthropicBatchId);
    for await (const item of stream) {
      const clientRef = refByCustomId.get(item.custom_id) ?? item.custom_id;
      results.push(this.toItemResult(clientRef, item.result));
    }

    return { processingStatus: 'ended', counts, results };
  }

  private toItemResult(clientRef: string, result: MessageBatchResult): BatchItemResult {
    switch (result.type) {
      case 'succeeded': {
        const msg = result.message;
        const reply = msg.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('');
        return {
          clientRef,
          status: 'done',
          reply,
          tokenUsage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          },
        };
      }
      case 'errored':
        return {
          clientRef,
          status: 'failed',
          error: result.error?.error?.message ?? 'errored',
        };
      case 'canceled':
        return { clientRef, status: 'failed', error: 'canceled' };
      case 'expired':
        return { clientRef, status: 'failed', error: 'expired' };
      default:
        return { clientRef, status: 'failed', error: 'unknown' };
    }
  }
}
