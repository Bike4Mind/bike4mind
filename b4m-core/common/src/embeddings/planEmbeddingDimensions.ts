import type { EmbeddingModelId } from '../schemas/embedding';
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

// A `discrete` catalog entry promises the provider forwards `outputDimension` (Voyage and Cohere).
// Titan and Ollama retain their native width; range models shorten and normalize locally.
export function planEmbeddingDimensions(
  model: EmbeddingModelId,
  requested: number | undefined
): EmbeddingDimensionPlan {
  const capabilities = getEmbeddingModelCapabilities(model);
  const { dimensions } = capabilities;
  if (requested !== undefined && (!Number.isInteger(requested) || requested <= 0)) {
    return { kind: 'unsupported', message: 'Embedding dimensions must be a positive integer.' };
  }
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
