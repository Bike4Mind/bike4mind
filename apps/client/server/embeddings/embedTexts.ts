import { truncateEmbedding } from '@bike4mind/common';
import type { EmbeddingService } from '@bike4mind/fab-pipeline';
import pLimit from 'p-limit';
import type { EmbeddingDimensionPlan } from './planEmbeddingDimensions';

type ResolvedDimensionPlan = Exclude<EmbeddingDimensionPlan, { kind: 'unsupported' }>;

type BatchEmbeddingService = EmbeddingService & {
  generateEmbeddingBatch(texts: string[], tokenCounts?: number[]): Promise<number[][]>;
};

// Providers with no batch API get one request per text; bounded so a large request cannot open a
// socket per input or trip the provider's own rate limit on the first burst.
const PER_TEXT_CONCURRENCY = 8;

function hasBatchApi(service: EmbeddingService): service is BatchEmbeddingService {
  return typeof (service as Partial<BatchEmbeddingService>).generateEmbeddingBatch === 'function';
}

/**
 * Embed `texts` in input order at the width `plan` describes. Throws on any provider failure - a
 * partial result is never returned, because the caller bills for the whole request.
 */
export async function embedTexts(
  service: EmbeddingService,
  texts: string[],
  tokenCounts: number[],
  plan: ResolvedDimensionPlan
): Promise<number[][]> {
  const vectors = await embedAtProviderWidth(service, texts, tokenCounts, plan);
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding provider returned ${vectors.length} vectors for ${texts.length} inputs`);
  }
  return plan.kind === 'truncate' ? vectors.map(vector => truncateEmbedding(vector, plan.dimensions)) : vectors;
}

async function embedAtProviderWidth(
  service: EmbeddingService,
  texts: string[],
  tokenCounts: number[],
  plan: ResolvedDimensionPlan
): Promise<number[][]> {
  // Only Voyage shortens natively, and it has no batch API, so the batch path never needs the width.
  if (plan.kind !== 'provider' && hasBatchApi(service)) {
    return service.generateEmbeddingBatch(texts, tokenCounts);
  }
  const options = plan.kind === 'provider' ? { outputDimension: plan.outputDimension } : undefined;
  const limit = pLimit(PER_TEXT_CONCURRENCY);
  return Promise.all(texts.map(text => limit(() => service.generateEmbedding(text, options))));
}

/** OpenAI's `encoding_format: "base64"`: the little-endian float32 bytes of the vector. */
export function encodeEmbeddingBase64(vector: readonly number[]): string {
  const buffer = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return buffer.toString('base64');
}
