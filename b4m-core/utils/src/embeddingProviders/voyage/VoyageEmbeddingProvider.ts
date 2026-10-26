import { z } from 'zod';
import { isPlaceholderApiKey } from '@bike4mind/common';
import { EmbeddingAuthError } from '@bike4mind/fab-pipeline';
import { VOYAGE_KEY_MISSING_MESSAGE } from '../keyMessages';
import { embeddingModelsOf } from '../models';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';

// Per-request input-count ceiling from the voyageai SDK's own request docs (128). Voyage's web docs now quote a
// higher cap; the conservative figure only costs extra requests.
const VOYAGE_MAX_INPUTS_PER_REQUEST = 128;

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

  constructor({ apiKey }: { apiKey?: string | null }) {
    if (isPlaceholderApiKey(apiKey)) throw new Error(VOYAGE_KEY_MISSING_MESSAGE);
    this.apiKey = apiKey as string;
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    const plan = preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };

    const outputDimension = plan.kind === 'provider' ? plan.outputDimension : undefined;
    const vectors: number[][] = [];
    const reportedTokens: (number | undefined)[] = [];
    for (let start = 0; start < request.inputs.length; start += VOYAGE_MAX_INPUTS_PER_REQUEST) {
      const batch = request.inputs.slice(start, start + VOYAGE_MAX_INPUTS_PER_REQUEST);
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
    const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: inputs,
        model,
        ...(outputDimension !== undefined && { output_dimension: outputDimension }),
      }),
      signal: context.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new EmbeddingAuthError(
        'voyage',
        `VoyageAI rejected the embedding request (${response.status}): the VOYAGE_API_KEY is invalid or expired. ` +
          `Set a valid key, or for an airgapped self-host set OLLAMA_BASE_URL to use a local embedder.`
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Voyage AI embed request failed (${response.status} ${response.statusText}): ${body}`);
    }

    const parsed = voyageResponseSchema.parse(await response.json());
    if (!parsed.data || parsed.data.length === 0) throw new Error('No embedding data received from Voyage AI');
    const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
    assertOneVectorPerInput('Voyage AI', inputs.length, sorted.length);
    return { vectors: sorted.map(item => item.embedding), inputTokens: parsed.usage?.total_tokens };
  }
}
