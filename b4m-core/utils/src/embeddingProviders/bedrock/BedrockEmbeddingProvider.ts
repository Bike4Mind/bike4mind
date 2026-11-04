import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { ApiBedrockEmbeddingModel, bedrockClientConfig, getEmbeddingModelCapabilities } from '@bike4mind/common';
import { embeddingModelsOf } from '../models';
import { mapWithConcurrency } from '../mapWithConcurrency';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

// Titan has no batch API: one request per text, bounded so a large request cannot open a socket per input or trip
// the account's rate limit on the first burst.
const BEDROCK_PER_TEXT_CONCURRENCY = 8;
const COHERE_MAX_BATCH_INPUTS = 96;
const COHERE_BATCH_CHARACTER_BUDGET = 128_000;

type BedrockClient = Pick<BedrockRuntimeClient, 'send'>;

const PARSE_FAILURE_MESSAGE = 'Failed to parse Bedrock embedding response';

const parseTitanResponse = (body: Uint8Array | undefined): { embedding: number[]; tokenCount?: number } => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== 'object' || parsed === null) throw new Error(PARSE_FAILURE_MESSAGE);
    const { embedding, inputTextTokenCount } = parsed as { embedding?: unknown; inputTextTokenCount?: unknown };
    if (!Array.isArray(embedding)) throw new Error(PARSE_FAILURE_MESSAGE);
    return {
      embedding: embedding as number[],
      tokenCount: typeof inputTextTokenCount === 'number' ? inputTextTokenCount : undefined,
    };
  } catch {
    throw new Error(PARSE_FAILURE_MESSAGE);
  }
};

export class BedrockEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'bedrock';
  readonly models;
  private readonly cohereModelId: string | undefined;

  private readonly client: BedrockClient;

  constructor({ client, cohereModelId }: { client?: BedrockClient; cohereModelId?: string } = {}) {
    this.cohereModelId = cohereModelId?.trim() || undefined;
    this.models = embeddingModelsOf('bedrock').filter(
      model => model !== ApiBedrockEmbeddingModel.COHERE_EMBED_V4 || this.cohereModelId !== undefined
    );
    this.client = client ?? new BedrockRuntimeClient(bedrockClientConfig());
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };
    context.signal?.throwIfAborted();

    if (request.model === ApiBedrockEmbeddingModel.COHERE_EMBED_V4) return this.embedCohere(request, context);

    const results = await mapWithConcurrency(request.inputs, BEDROCK_PER_TEXT_CONCURRENCY, async text => {
      const command = new InvokeModelCommand({ modelId: request.model, body: JSON.stringify({ inputText: text }) });
      const response = await this.client.send(command, { abortSignal: context.signal });
      return parseTitanResponse(response.body);
    });

    assertOneVectorPerInput('Bedrock', request.inputs.length, results.length);
    return {
      vectors: results.map(result => result.embedding),
      inputTokens: sumReportedTokens(results.map(result => result.tokenCount)),
    };
  }
  private async embedCohere(request: EmbeddingRequest, context: EmbeddingContext): Promise<EmbeddingResult> {
    const outputDimensions = request.dimensions ?? getEmbeddingModelCapabilities(request.model).dimensions.native;
    const vectors: number[][] = [];
    const counts: (number | undefined)[] = [];
    const schema = z.object({
      embeddings: z.union([z.array(z.array(z.number())), z.object({ float: z.array(z.array(z.number())) })]),
      meta: z
        .object({ billed_units: z.object({ input_tokens: z.number().int().nonnegative().optional() }).optional() })
        .optional(),
    });
    // Bedrock caps texts at 96 per request; keep total text below its 128k-token request budget too.
    const batches: string[][] = [];
    let batch: string[] = [];
    let characters = 0;
    for (const text of request.inputs) {
      if (
        batch.length > 0 &&
        (batch.length === COHERE_MAX_BATCH_INPUTS || characters + text.length > COHERE_BATCH_CHARACTER_BUDGET)
      ) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(text);
      characters += text.length;
    }
    if (batch.length > 0) batches.push(batch);
    for (const texts of batches) {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.cohereModelId,
          body: JSON.stringify({
            texts,
            input_type: request.inputType === 'query' ? 'search_query' : 'search_document',
            output_dimension: outputDimensions,
            embedding_types: ['float'],
            truncate: 'NONE',
          }),
        }),
        { abortSignal: context.signal }
      );
      const parsed = schema.parse(JSON.parse(new TextDecoder().decode(response.body)));
      const embeddings = Array.isArray(parsed.embeddings) ? parsed.embeddings : parsed.embeddings.float;
      assertOneVectorPerInput('Cohere', texts.length, embeddings.length);
      if (embeddings.some(vector => vector.length !== outputDimensions)) {
        throw new Error('Cohere returned an unexpected embedding width');
      }
      vectors.push(...embeddings);
      counts.push(parsed.meta?.billed_units?.input_tokens);
    }
    return { vectors, inputTokens: sumReportedTokens(counts) };
  }
}
