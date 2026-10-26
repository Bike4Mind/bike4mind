import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { isPlaceholderApiKey, truncateEmbedding } from '@bike4mind/common';
import {
  EmbeddingAuthError,
  EmbeddingModelProvider,
  OPENAI_EFFECTIVE_TOKEN_LIMIT,
  OPENAI_MAX_INPUTS_PER_REQUEST,
  OPENAI_KEY_MISSING_MESSAGE,
  OPENAI_MAX_TOKENS_PER_INPUT,
  recordEmbeddingRateLimitHeaders,
} from '@bike4mind/fab-pipeline';
import { Logger } from '@bike4mind/observability';
import { embeddingModelsOf } from '../models';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

type BatchOutcome = { vectors: number[][]; inputTokens?: number };

/**
 * Non-reversible stand-in for a credential, so two accounts can be told apart in a log. Never emit the key.
 */
const fingerprintCredential = (apiKey: string): string =>
  `key:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;

/**
 * Total by construction: it runs inside the batch's classifying try, where a throw would be misread as a provider
 * error and re-issue the batch.
 */
const headerOrNull = (httpResponse: Response, name: string): string | null => {
  try {
    return httpResponse.headers?.get(name) ?? null;
  } catch {
    return null;
  }
};

/**
 * Embeds through the OpenAI SDK. Splits on the same ceilings as fab-pipeline's OpenAIEmbeddingService (imported, so
 * they cannot drift): input count, effective token budget, then a tiktoken re-count with recursive halving when the
 * API still rejects a batch as too large. Width-reduced `range` models embed at full width and are truncated
 * client-side, matching `embedTexts`; the API `dimensions` parameter is never sent.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly models = embeddingModelsOf('openai');

  private readonly client: OpenAI;
  private readonly credentialFingerprint: string;

  constructor({ apiKey }: { apiKey?: string | null }) {
    if (isPlaceholderApiKey(apiKey)) throw new Error(OPENAI_KEY_MISSING_MESSAGE);
    this.client = new OpenAI({ apiKey: apiKey as string });
    this.credentialFingerprint = fingerprintCredential(apiKey as string);
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    const plan = preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };
    context.signal?.throwIfAborted();

    const texts = [...request.inputs];
    const tokenCounts = await this.countTokens(texts);
    tokenCounts.forEach((count, index) => {
      if (count > OPENAI_MAX_TOKENS_PER_INPUT) {
        throw new Error(`Input at index ${index} exceeds ${OPENAI_MAX_TOKENS_PER_INPUT} token limit (${count} tokens)`);
      }
    });

    const vectors: number[][] = [];
    const reportedTokens: (number | undefined)[] = [];
    for (const batch of this.createBatches(texts, tokenCounts)) {
      const outcome = await this.embedBatch(request, batch.texts, batch.tokenCounts, context);
      vectors.push(...outcome.vectors);
      reportedTokens.push(outcome.inputTokens);
    }

    assertOneVectorPerInput('OpenAI', texts.length, vectors.length);
    return {
      vectors: plan.kind === 'truncate' ? vectors.map(vector => truncateEmbedding(vector, plan.dimensions)) : vectors,
      inputTokens: sumReportedTokens(reportedTokens),
    };
  }

  private async countTokens(texts: string[]): Promise<number[]> {
    try {
      const { encoding_for_model } = await import('tiktoken');
      const encoding = encoding_for_model('text-embedding-ada-002');
      try {
        // encode_ordinary: encode rejects a special-token literal in file content, which would drop the whole
        // batch to the chars/3 estimate over one string.
        return texts.map(text => encoding.encode_ordinary(text).length);
      } finally {
        encoding.free();
      }
    } catch {
      // Overestimating only causes extra splits; underestimating causes API failures. Code averages ~3 chars/token.
      Logger.globalInstance.warn('tiktoken not available, using conservative token estimation (chars/3)');
      return texts.map(text => Math.ceil(text.length / 3));
    }
  }

  private createBatches(texts: string[], tokenCounts: number[]): Array<{ texts: string[]; tokenCounts: number[] }> {
    const batches: Array<{ texts: string[]; tokenCounts: number[] }> = [];
    let current: { texts: string[]; tokenCounts: number[] } = { texts: [], tokenCounts: [] };
    let currentTokens = 0;

    texts.forEach((text, index) => {
      const tokens = tokenCounts[index];
      const full =
        current.texts.length >= OPENAI_MAX_INPUTS_PER_REQUEST || currentTokens + tokens > OPENAI_EFFECTIVE_TOKEN_LIMIT;
      if (full && current.texts.length > 0) {
        batches.push(current);
        current = { texts: [], tokenCounts: [] };
        currentTokens = 0;
      }
      current.texts.push(text);
      current.tokenCounts.push(tokens);
      currentTokens += tokens;
    });

    if (current.texts.length > 0) batches.push(current);
    return batches;
  }

  private async embedBatch(
    request: EmbeddingRequest,
    texts: string[],
    tokenCounts: number[],
    context: EmbeddingContext
  ): Promise<BatchOutcome> {
    try {
      const { data: body, response: httpResponse } = await this.client.embeddings
        .create({ model: request.model, input: texts }, { signal: context.signal })
        .withResponse();

      // Must not throw: this catch classifies failures into split-and-retry or per-text fallback, so a reporting
      // fault would be misread as a provider error. recordEmbeddingRateLimitHeaders swallows its own faults.
      this.recordRateLimit(request.model, httpResponse);

      if (!body.data || body.data.length === 0) throw new Error('No embedding data received from OpenAI');
      assertOneVectorPerInput('OpenAI', texts.length, body.data.length);
      const sorted = [...body.data].sort((a, b) => a.index - b.index);
      return { vectors: sorted.map(item => item.embedding), inputTokens: body.usage?.prompt_tokens };
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) throw this.toAuthError(error);

      if (this.isTokenLimitError(error)) {
        // A single text cannot be split further.
        if (texts.length === 1) throw error;
        Logger.globalInstance.warn(`[OpenAI] API rejected batch due to token limit, splitting ${texts.length} texts`);
        return this.embedHalves(request, texts, tokenCounts, context);
      }

      if (this.shouldFallbackToIndividual(error)) {
        Logger.globalInstance.warn(`[OpenAI] Batch embedding failed, falling back to individual calls: ${error}`);
        return this.embedIndividually(request, texts, context);
      }
      throw error;
    }
  }

  private async embedHalves(
    request: EmbeddingRequest,
    texts: string[],
    tokenCounts: number[],
    context: EmbeddingContext
  ): Promise<BatchOutcome> {
    const mid = Math.ceil(texts.length / 2);
    const [first, second] = await Promise.all([
      this.embedBatch(request, texts.slice(0, mid), tokenCounts.slice(0, mid), context),
      this.embedBatch(request, texts.slice(mid), tokenCounts.slice(mid), context),
    ]);
    return {
      vectors: [...first.vectors, ...second.vectors],
      inputTokens: sumReportedTokens([first.inputTokens, second.inputTokens]),
    };
  }

  private async embedIndividually(
    request: EmbeddingRequest,
    texts: string[],
    context: EmbeddingContext
  ): Promise<BatchOutcome> {
    const vectors: number[][] = [];
    const reportedTokens: (number | undefined)[] = [];
    for (const text of texts) {
      const { data: body, response: httpResponse } = await this.client.embeddings
        .create({ model: request.model, input: text }, { signal: context.signal })
        .withResponse()
        .catch((error: unknown) => {
          throw error instanceof OpenAI.AuthenticationError ? this.toAuthError(error) : error;
        });
      this.recordRateLimit(request.model, httpResponse);
      if (!body.data || body.data.length === 0) throw new Error('No embedding data received from OpenAI');
      assertOneVectorPerInput('OpenAI', 1, body.data.length);
      vectors.push(body.data[0].embedding);
      reportedTokens.push(body.usage?.prompt_tokens);
    }
    return { vectors, inputTokens: sumReportedTokens(reportedTokens) };
  }

  /**
   * The ceiling belongs to the organization behind the key, and keys are resolved per user, so the reading names
   * whose it is: the provider's own `openai-organization` header, else a credential fingerprint.
   */
  private recordRateLimit(model: string, httpResponse: Response): void {
    const account = headerOrNull(httpResponse, 'openai-organization') || this.credentialFingerprint;
    recordEmbeddingRateLimitHeaders(EmbeddingModelProvider.OPENAI, model, account, httpResponse.headers);
  }

  // Operator-actionable text goes to logs; user-facing surfaces map EmbeddingAuthError to their own copy.
  private toAuthError(error: InstanceType<typeof OpenAI.AuthenticationError>): EmbeddingAuthError {
    return new EmbeddingAuthError(
      'openai',
      `OpenAI rejected the embedding request (401 Unauthorized): the OPENAI_API_KEY is invalid or expired. ` +
        `Set a valid key, or for an airgapped self-host unset it and set OLLAMA_BASE_URL to use a local embedder. ` +
        `(original: ${error.message})`,
      { cause: error }
    );
  }

  private isTokenLimitError(error: unknown): boolean {
    if (!(error instanceof OpenAI.BadRequestError)) return false;
    const body = error.error as { type?: string } | undefined;
    return body?.type === 'max_tokens_per_request';
  }

  /** Rate limits (429) and server errors (5xx) fall back to per-text calls; auth and validation errors do not. */
  private shouldFallbackToIndividual(error: unknown): boolean {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    return status === 429 || (status !== undefined && status >= 500 && status < 600);
  }
}
