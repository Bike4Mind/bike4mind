import { EntityMentionSource } from '../types';
import { EntityExtractor, ExtractionResult } from './types';

/**
 * Regex patterns for extracting Confluence entities from text
 */
const CONFLUENCE_PATTERNS = {
  // Confluence page URL patterns
  // https://company.atlassian.net/wiki/spaces/SPACE/pages/123456/Page+Title
  pageUrl: /https?:\/\/[a-zA-Z0-9_-]+\.atlassian\.net\/wiki\/spaces\/([A-Z0-9_-]+)\/pages\/(\d+)(?:\/([^?\s]+))?/gi,

  // https://company.atlassian.net/wiki/spaces/SPACE
  spaceUrl: /https?:\/\/[a-zA-Z0-9_-]+\.atlassian\.net\/wiki\/spaces\/([A-Z0-9_-]+)(?:\/|$|\s|[)\]>])/gi,

  // Space key mentioned in context (e.g., "in the DOCS space")
  spaceMention: /(?:space|confluence space)\s+([A-Z][A-Z0-9_-]{0,9})\b/gi,

  // Page ID pattern (often appears in tool results)
  pageId: /(?:pageId|page_id|page id)[:\s]+["']?(\d+)["']?/gi,
};

/**
 * Confluence entity extractor using regex patterns
 */
export class ConfluenceExtractor implements EntityExtractor {
  /**
   * Extract Confluence entities from text
   */
  extract(text: string, source: EntityMentionSource): ExtractionResult {
    const entities: ExtractionResult['entities'] = [];
    const seenSpaces = new Set<string>();
    const seenPages = new Set<string>();

    // Extract page URLs
    let match;
    CONFLUENCE_PATTERNS.pageUrl.lastIndex = 0;
    while ((match = CONFLUENCE_PATTERNS.pageUrl.exec(text)) !== null) {
      const [, spaceKey, pageId, encodedTitle] = match;
      if (!seenPages.has(pageId)) {
        seenPages.add(pageId);
        // Decode the title from URL encoding (with fallback for malformed URLs)
        let title = `Page ${pageId}`;
        if (encodedTitle) {
          try {
            title = decodeURIComponent(encodedTitle.replace(/\+/g, ' '));
          } catch {
            // Fallback if URL is malformed
            title = encodedTitle.replace(/\+/g, ' ');
          }
        }
        entities.push({
          entity: {
            type: 'confluence_page',
            entity: {
              id: pageId,
              title,
              spaceKey: spaceKey.toUpperCase(),
            },
          },
          source,
        });
        // Also add the space
        const spaceKeyUpper = spaceKey.toUpperCase();
        if (!seenSpaces.has(spaceKeyUpper)) {
          seenSpaces.add(spaceKeyUpper);
          entities.push({
            entity: {
              type: 'confluence_space',
              entity: { key: spaceKeyUpper },
            },
            source,
          });
        }
      }
    }

    // Extract space URLs
    CONFLUENCE_PATTERNS.spaceUrl.lastIndex = 0;
    while ((match = CONFLUENCE_PATTERNS.spaceUrl.exec(text)) !== null) {
      const [, spaceKey] = match;
      const spaceKeyUpper = spaceKey.toUpperCase();
      if (!seenSpaces.has(spaceKeyUpper)) {
        seenSpaces.add(spaceKeyUpper);
        entities.push({
          entity: {
            type: 'confluence_space',
            entity: { key: spaceKeyUpper },
          },
          source,
        });
      }
    }

    // Extract space mentions
    CONFLUENCE_PATTERNS.spaceMention.lastIndex = 0;
    while ((match = CONFLUENCE_PATTERNS.spaceMention.exec(text)) !== null) {
      const [, spaceKey] = match;
      const spaceKeyUpper = spaceKey.toUpperCase();
      if (!seenSpaces.has(spaceKeyUpper)) {
        seenSpaces.add(spaceKeyUpper);
        entities.push({
          entity: {
            type: 'confluence_space',
            entity: { key: spaceKeyUpper },
          },
          source,
        });
      }
    }

    // Extract page IDs from tool results or mentions
    CONFLUENCE_PATTERNS.pageId.lastIndex = 0;
    while ((match = CONFLUENCE_PATTERNS.pageId.exec(text)) !== null) {
      const [, pageId] = match;
      if (!seenPages.has(pageId)) {
        seenPages.add(pageId);
        entities.push({
          entity: {
            type: 'confluence_page',
            entity: {
              id: pageId,
              title: `Page ${pageId}`, // Title unknown from just ID
            },
          },
          source,
        });
      }
    }

    return { entities };
  }
}

/**
 * Singleton instance for convenience
 */
export const confluenceExtractor = new ConfluenceExtractor();
