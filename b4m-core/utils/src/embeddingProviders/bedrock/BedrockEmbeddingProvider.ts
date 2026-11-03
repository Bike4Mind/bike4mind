import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClientConfig } from '@bike4mind/common';
import { embeddingModelsOf } from '../models';
import { mapWithConcurrency } from '../mapWithConcurrency';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

// Titan has no batch API: one request per text, bounded so a large request cannot open a socket per input or trip
// the account's rate limit on the first burst.
const BEDROCK_PER_TEXT_CONCURRENCY = 8;

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
  readonly models = embeddingModelsOf('bedrock');

  private readonly client: BedrockClient;

  constructor({ client }: { client?: BedrockClient } = {}) {
    this.client = client ?? new BedrockRuntimeClient(bedrockClientConfig());
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };
    context.signal?.throwIfAborted();

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
}
