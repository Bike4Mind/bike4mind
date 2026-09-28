import { OpenAIEmbeddingModel, VoyageAIEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import type { EmbeddingModelInfo } from '@bike4mind/fab-pipeline';

/**
 * How a requested output width is produced for one model.
 *
 * - `native`: the model's default width; nothing to do.
 * - `provider`: the provider shortens it itself (Voyage honours `outputDimension`).
 * - `truncate`: embed at full width, then truncate + renormalize (Matryoshka-trained OpenAI models).
 * - `unsupported`: the model cannot produce that width; `message` is caller-facing.
 */
export type EmbeddingDimensionPlan =
  | { kind: 'native' }
  | { kind: 'provider'; outputDimension: number }
  | { kind: 'truncate'; dimensions: number }
  | { kind: 'unsupported'; message: string };

const TRUNCATABLE_MODELS: ReadonlySet<SupportedEmbeddingModel> = new Set([
  OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
  OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE,
]);

// Must stay in sync with the providers whose generateEmbedding actually forwards `outputDimension`
// (fab-pipeline VoyageAIEmbeddingService); Bedrock and Ollama ignore it.
const PROVIDER_SHORTENED_MODELS: ReadonlySet<SupportedEmbeddingModel> = new Set(Object.values(VoyageAIEmbeddingModel));

export function planEmbeddingDimensions(
  model: SupportedEmbeddingModel,
  modelInfo: EmbeddingModelInfo<string>,
  requested: number | undefined
): EmbeddingDimensionPlan {
  const [nativeWidth] = modelInfo.dimensions;
  if (requested === undefined || requested === nativeWidth) return { kind: 'native' };

  if (TRUNCATABLE_MODELS.has(model)) {
    return requested <= nativeWidth
      ? { kind: 'truncate', dimensions: requested }
      : { kind: 'unsupported', message: `${model} supports dimensions from 1 to ${nativeWidth}.` };
  }

  if (PROVIDER_SHORTENED_MODELS.has(model) && modelInfo.dimensions.includes(requested)) {
    return { kind: 'provider', outputDimension: requested };
  }

  const supported = PROVIDER_SHORTENED_MODELS.has(model) ? modelInfo.dimensions : [nativeWidth];
  return { kind: 'unsupported', message: `${model} supports dimensions: ${supported.join(', ')}.` };
}
