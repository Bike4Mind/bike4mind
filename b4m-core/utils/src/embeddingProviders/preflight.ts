import { planEmbeddingDimensions, type EmbeddingDimensionPlan } from '@bike4mind/common';
import type { EmbeddingProvider, EmbeddingRequest } from './types';

export type ResolvedEmbeddingPlan = Exclude<EmbeddingDimensionPlan, { kind: 'unsupported' }>;

/**
 * Shared pre-flight for every provider: rejects a model the provider does not serve or a width the model cannot
 * produce, before any network call. Returns how the requested width is produced.
 */
export function preflightEmbeddingRequest(
  provider: Pick<EmbeddingProvider, 'id' | 'models'>,
  request: EmbeddingRequest
): ResolvedEmbeddingPlan {
  if (!provider.models.includes(request.model)) {
    throw new Error(`The ${provider.id} embedding provider does not serve model "${request.model}".`);
  }
  const plan = planEmbeddingDimensions(request.model, request.dimensions);
  if (plan.kind === 'unsupported') throw new Error(plan.message);
  return plan;
}

/** Providers must never return a partial or padded result; the caller bills for the whole request. */
export function assertOneVectorPerInput(providerLabel: string, inputCount: number, vectorCount: number): void {
  if (vectorCount !== inputCount) {
    throw new Error(`${providerLabel} returned ${vectorCount} embeddings for ${inputCount} input(s)`);
  }
}

/** Sums the token counts a provider reported; undefined when none of the responses carried one. */
export const sumReportedTokens = (counts: readonly (number | undefined)[]): number | undefined => {
  const reported = counts.filter((count): count is number => count !== undefined);
  return reported.length === 0 ? undefined : reported.reduce((sum, count) => sum + count, 0);
};
