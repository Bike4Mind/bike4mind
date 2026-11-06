import { z } from 'zod';
import { isPlaceholderApiKey } from '@bike4mind/common';
import { EmbeddingAuthError, VOYAGE_KEY_MISSING_MESSAGE } from '@bike4mind/fab-pipeline';
import { embeddingModelsOf } from '../models';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';

// Per-request input-count ceiling from the voyageai SDK's own request docs (128). Voyage's web docs now quote a
// higher cap; the conservative figure only costs extra requests.
const VOYAGE_MAX_INPUTS_PER_REQUEST = 128;

// Voyage also caps total tokens per request (SDK EmbedRequest docs: 120K for the large/code/law/finance families,
// 320K for the base ones). A token is at least one character, so characters over-estimate tokens without a tokenizer;
// the smallest cap for every model keeps this one constant.
const VOYAGE_MAX_CHARS_PER_REQUEST = 120_000;

// Matches the voyageai SDK this replaces: two retries with exponential backoff and jitter, 60s per attempt.
const VOYAGE_MAX_RETRIES = 2;
const VOYAGE_ATTEMPT_TIMEOUT_MS = 60_000;

const defaultRetryDelayMs = (retry: number): number => 500 * 2 ** retry * (1 - Math.random() * 0.25);

const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** Splits into consecutive batches within both the input-count and character budgets; an oversized input goes alone. */
function createBatches(inputs: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const input of inputs) {
    const full =
      current.length >= VOYAGE_MAX_INPUTS_PER_REQUEST || currentChars + input.length > VOYAGE_MAX_CHARS_PER_REQUEST;
    if (full && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(input);
    currentChars += input.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const voyageResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })).optional(),
  usage: z.object({ total_tokens: z.number().optional() }).optional(),
});

/**
 * Calls Voyage's REST API directly (no SDK dependency). Voyage shortens vectors itself, so `output_dimension` is sent
 * only when the plan says the provider owns the width change (catalog `discrete` widths).
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'voyage';
  readonly models = embeddingModelsOf('voyage');

  private readonly apiKey: string;
  private readonly retryDelayMs: (retry: number) => number;

  /** `retryDelayMs` is injectable so tests need not wait out real backoff. */
  constructor({
    apiKey,
    retryDelayMs = defaultRetryDelayMs,
  }: {
    apiKey?: string | null;
    retryDelayMs?: (retry: number) => number;
  }) {
    this.retryDelayMs = retryDelayMs;
    if (isPlaceholderApiKey(apiKey)) throw new Error(VOYAGE_KEY_MISSING_MESSAGE);
    this.apiKey = apiKey as string;
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    const plan = preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };
    context.signal?.throwIfAborted();

    const outputDimension = plan.kind === 'provider' ? plan.outputDimension : undefined;
    const vectors: number[][] = [];
    const reportedTokens: (number | undefined)[] = [];
    for (const batch of createBatches(request.inputs)) {
      const outcome = await this.embedBatch(request.model, batch, outputDimension, context);
      vectors.push(...outcome.vectors);
      reportedTokens.push(outcome.inputTokens);
    }

    assertOneVectorPerInput('Voyage AI', request.inputs.length, vectors.length);
    return { vectors, inputTokens: sumReportedTokens(reportedTokens) };
  }

  private async embedBatch(
    model: string,
    inputs: readonly string[],
    outputDimension: number | undefined,
    context: EmbeddingContext
  ): Promise<{ vectors: number[][]; inputTokens?: number }> {
    const body = JSON.stringify({
      input: inputs,
      model,
      ...(outputDimension !== undefined && { output_dimension: outputDimension }),
    });
    const response = await this.postWithRetry(body, context);

    if (response.status === 401 || response.status === 403) {
      throw new EmbeddingAuthError(
        'voyage',
        `VoyageAI rejected the embedding request (${response.status}): the VOYAGE_API_KEY is invalid or expired. ` +
          `Set a valid key, or for an airgapped self-host set OLLAMA_BASE_URL to use a local embedder.`
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Voyage AI embed request failed (${response.status} ${response.statusText}): ${detail}`);
    }

    const parsed = voyageResponseSchema.parse(await response.json());
    if (!parsed.data || parsed.data.length === 0) throw new Error('No embedding data received from Voyage AI');
    const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
    assertOneVectorPerInput('Voyage AI', inputs.length, sorted.length);
    return { vectors: sorted.map(item => item.embedding), inputTokens: parsed.usage?.total_tokens };
  }

  /** Retries network errors and 408/429/5xx; every other response (401, 403, other 4xx) is returned for the caller. */
  private async postWithRetry(body: string, context: EmbeddingContext): Promise<Response> {
    for (let retry = 0; ; retry++) {
      context.signal?.throwIfAborted();
      const signals = [AbortSignal.timeout(VOYAGE_ATTEMPT_TIMEOUT_MS), ...(context.signal ? [context.signal] : [])];
      let response: Response | undefined;
      try {
        response = await fetch(VOYAGE_EMBEDDINGS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (context.signal?.aborted || retry >= VOYAGE_MAX_RETRIES) throw error;
      }
      if (response && (!isRetryableStatus(response.status) || retry >= VOYAGE_MAX_RETRIES)) return response;
      // Drain rather than cancel so the connection is reusable.
      await response?.arrayBuffer().catch(() => undefined);
      await this.sleep(this.retryDelayMs(retry), context.signal);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      // Detach on resolve too: the caller's signal can outlive many sleeps, and each would otherwise keep a listener.
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
