import { z } from 'zod';
import { getEmbeddingModelCapabilities, isPlaceholderApiKey, truncateEmbedding } from '@bike4mind/common';
import { EmbeddingAuthError } from '@bike4mind/fab-pipeline';
import { embeddingModelsOf } from '../models';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

const GEMINI_BATCH_SIZE = 100;
const responseSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
  usageMetadata: z.object({ promptTokenCount: z.number().int().nonnegative().optional() }).optional(),
});

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini';
  readonly models = embeddingModelsOf('gemini');
  private readonly apiKey: string;

  constructor({ apiKey }: { apiKey?: string | null }) {
    if (!apiKey || isPlaceholderApiKey(apiKey)) throw new Error('Gemini embedding API key is not configured');
    this.apiKey = apiKey;
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    const plan = preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };
    context.signal?.throwIfAborted();
    const vectors: number[][] = [];
    const counts: (number | undefined)[] = [];
    for (let offset = 0; offset < request.inputs.length; offset += GEMINI_BATCH_SIZE) {
      const inputs = request.inputs.slice(offset, offset + GEMINI_BATCH_SIZE);
      const result = await this.embedBatch(request, inputs, context);
      vectors.push(...result.vectors);
      counts.push(result.inputTokens);
    }
    assertOneVectorPerInput('Gemini', request.inputs.length, vectors.length);
    return {
      vectors: plan.kind === 'truncate' ? vectors.map(vector => truncateEmbedding(vector, plan.dimensions)) : vectors,
      inputTokens: sumReportedTokens(counts),
    };
  }

  private async embedBatch(
    request: EmbeddingRequest,
    inputs: readonly string[],
    context: EmbeddingContext
  ): Promise<EmbeddingResult> {
    const model = `models/${request.model}`;
    const nativeWidth = getEmbeddingModelCapabilities(request.model).dimensions.native;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: inputs.map(text => ({
          model,
          content: { parts: [{ text }] },
          ...(request.inputType && {
            taskType: request.inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          }),
        })),
      }),
      signal: context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new EmbeddingAuthError('gemini', 'Gemini rejected the embedding credential');
    }
    if (!response.ok) throw new Error(`Gemini embedding request failed (${response.status})`);
    const parsed = responseSchema.parse(await response.json());
    assertOneVectorPerInput('Gemini', inputs.length, parsed.embeddings.length);
    if (parsed.embeddings.some(embedding => embedding.values.length !== nativeWidth)) {
      throw new Error('Gemini returned an unexpected embedding width');
    }
    return {
      vectors: parsed.embeddings.map(embedding => embedding.values),
      inputTokens: parsed.usageMetadata?.promptTokenCount,
    };
  }
}
