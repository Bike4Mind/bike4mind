import { ConversationEntity, EntityMentionSource } from '../types';

/**
 * Result of entity extraction from text
 */
export interface ExtractionResult {
  entities: Array<{
    entity: ConversationEntity;
    source: EntityMentionSource;
  }>;
}

/**
 * Interface for an entity extractor
 */
export interface EntityExtractor {
  /**
   * Extract entities from text content
   * @param text - The text to extract entities from
   * @param source - The source of the text (user, assistant, tool_result)
   * @returns Extracted entities
   */
  extract(text: string, source: EntityMentionSource): ExtractionResult;
}
