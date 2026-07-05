/**
 * Entity Extractors for Conversation Context
 *
 * Provides regex-based extraction of entities from text for:
 * - GitHub (repos, PRs, issues)
 * - Jira (projects, issues)
 * - Confluence (spaces, pages)
 */

import { EntityMentionSource } from '../types';
import { ExtractionResult } from './types';
import { githubExtractor } from './github';
import { jiraExtractor } from './jira';
import { confluenceExtractor } from './confluence';

export type { ExtractionResult, EntityExtractor } from './types';
export { GitHubExtractor, githubExtractor } from './github';
export { JiraExtractor, jiraExtractor } from './jira';
export { ConfluenceExtractor, confluenceExtractor } from './confluence';

/**
 * Combined extractor that runs all integration-specific extractors
 */
export class CombinedExtractor {
  private extractors = [githubExtractor, jiraExtractor, confluenceExtractor];

  /**
   * Extract all entities from text using all available extractors
   *
   * @param text - The text to extract entities from
   * @param source - The source of the text
   * @returns Combined extraction results from all extractors
   */
  extract(text: string, source: EntityMentionSource): ExtractionResult {
    const allEntities: ExtractionResult['entities'] = [];

    for (const extractor of this.extractors) {
      const result = extractor.extract(text, source);
      allEntities.push(...result.entities);
    }

    return { entities: allEntities };
  }

  /**
   * Extract entities from multiple text blocks (e.g., messages in a conversation)
   *
   * @param texts - Array of text content with their sources
   * @returns Combined extraction results
   */
  extractFromMultiple(texts: Array<{ text: string; source: EntityMentionSource }>): ExtractionResult {
    const allEntities: ExtractionResult['entities'] = [];

    for (const { text, source } of texts) {
      const result = this.extract(text, source);
      allEntities.push(...result.entities);
    }

    return { entities: allEntities };
  }
}

/**
 * Singleton instance for convenience
 */
export const combinedExtractor = new CombinedExtractor();

/**
 * Convenience function to extract all entities from text
 */
export function extractEntities(text: string, source: EntityMentionSource): ExtractionResult {
  return combinedExtractor.extract(text, source);
}

/**
 * Convenience function to extract entities from multiple texts
 */
export function extractEntitiesFromMultiple(
  texts: Array<{ text: string; source: EntityMentionSource }>
): ExtractionResult {
  return combinedExtractor.extractFromMultiple(texts);
}
