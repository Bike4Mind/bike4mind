/**
 * Searcher implementations and utilities for deep research
 *
 * This module provides the base interfaces and types for implementing custom searchers
 * that can be used with the deep research tool.
 */

export type { Searcher, SearchResult, ContentExtractionResult } from './index';

/**
 * Example: Creating a custom database searcher
 *
 * ```typescript
 * import { Searcher, SearchResult, ContentExtractionResult } from './searchers';
 *
 * const databaseSearcher: Searcher = {
 *   name: 'Internal Database',
 *   search: async (query: string): Promise<SearchResult[]> => {
 *     const results = await database.search(query);
 *     return results.map(result => ({
 *       title: result.title,
 *       description: result.summary,
 *       content: result.fullText,
 *       url: result.id,
 *     }));
 *   },
 *   // Optional: extractContent is not needed if search() returns content
 * };
 *
 * // Use it in deepResearchConfig:
 * const context: ToolContext = {
 *   // ... other context properties
 *   deepResearchConfig: {
 *     maxDepth: 5,
 *     duration: 3,
 *     searchers: [databaseSearcher],
 *   },
 * };
 * ```
 *
 * Example: Creating a custom API searcher with content extraction
 *
 * ```typescript
 * const apiSearcher: Searcher = {
 *   name: 'Custom API',
 *   search: async (query: string): Promise<SearchResult[]> => {
 *     const response = await fetch(`https://api.example.com/search?q=${query}`);
 *     const data = await response.json();
 *     return data.results.map(r => ({
 *       url: r.url,
 *       title: r.title,
 *       description: r.snippet,
 *     }));
 *   },
 *   extractContent: async (urls: string[]): Promise<ContentExtractionResult[]> => {
 *     const results = await Promise.all(
 *       urls.map(async url => {
 *         const response = await fetch(`https://api.example.com/extract?url=${url}`);
 *         const data = await response.json();
 *         return {
 *           text: data.content,
 *           source: url,
 *         };
 *       })
 *     );
 *     return results;
 *   },
 * };
 * ```
 *
 * Example: Using multiple searchers
 *
 * ```typescript
 * const context: ToolContext = {
 *   // ... other context properties
 *   deepResearchConfig: {
 *     maxDepth: 7,
 *     duration: 5,
 *     searchers: [
 *       firecrawlSearcher,  // Web search
 *       databaseSearcher,    // Internal knowledge base
 *       apiSearcher,         // External API
 *     ],
 *   },
 * };
 *
 * // The deep research tool will search across all searchers in parallel
 * // and combine the results for comprehensive research
 * ```
 */
