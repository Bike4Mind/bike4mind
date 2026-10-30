import type { SupportedEmbeddingModel } from '../schemas/embedding';
import { getEmbeddingModelCapabilities, servableEmbeddingDimensions } from './catalog';

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

// A `discrete` catalog entry promises the provider forwards `outputDimension`. Today the runtime forwarder is
// fab-pipeline's VoyageAIEmbeddingService, reached through embedTexts; the Voyage provider in
// utils/embeddingProviders honours it too. Bedrock and Ollama ignore it, so their models are declared `fixed`.
export function planEmbeddingDimensions(
  model: SupportedEmbeddingModel,
  requested: number | undefined
): EmbeddingDimensionPlan {
  const capabilities = getEmbeddingModelCapabilities(model);
  const { dimensions } = capabilities;
  if (requested === undefined || requested === dimensions.native) return { kind: 'native' };

  if (dimensions.kind === 'range') {
    return requested >= dimensions.min && requested <= dimensions.native
      ? { kind: 'truncate', dimensions: requested }
      : {
          kind: 'unsupported',
          message: `${model} supports dimensions from ${dimensions.min} to ${dimensions.native}.`,
        };
  }

  if (dimensions.kind === 'discrete' && dimensions.values.includes(requested)) {
    return { kind: 'provider', outputDimension: requested };
  }

  const supported = servableEmbeddingDimensions(capabilities);
  return { kind: 'unsupported', message: `${model} supports dimensions: ${supported.join(', ')}.` };
}
