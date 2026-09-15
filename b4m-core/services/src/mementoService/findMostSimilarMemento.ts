import { computeCosineSimilarity } from '@bike4mind/utils';
import { IMementoDocument } from '@bike4mind/common';

/**
 * Result of finding the most similar memento
 */
export interface SimilarMementoResult {
  memento: IMementoDocument | null;
  similarity: number;
}

/**
 * Finds the most similar memento to a given embedding from a list of mementos
 * Skips mementos without valid embeddings
 *
 * @param targetEmbedding - The embedding vector to compare against
 * @param mementos - Array of mementos to search through
 * @returns Object containing the most similar memento and its similarity score
 *
 * @example
 * ```typescript
 * const { memento, similarity } = findMostSimilarMemento(
 *   summaryEmbedding,
 *   existingMementos
 * );
 *
 * if (similarity >= 0.85) {
 *   console.log('Found duplicate:', memento.summary);
 * }
 * ```
 */
export function findMostSimilarMemento(targetEmbedding: number[], mementos: IMementoDocument[]): SimilarMementoResult {
  let highestSimilarity = 0;
  let mostSimilarMemento: IMementoDocument | null = null;

  for (const memento of mementos) {
    if (!memento.embedding || memento.embedding.length === 0) {
      continue;
    }

    const similarity = computeCosineSimilarity(targetEmbedding, memento.embedding);

    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      mostSimilarMemento = memento;
    }
  }

  return {
    memento: mostSimilarMemento,
    similarity: highestSimilarity,
  };
}
