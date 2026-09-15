/**
 * Source classification for UI rendering
 * Determines icon, color, and behavior
 */
export type CitableSourceType =
  | 'web_url' // External web URLs (from web_search, deep_research)
  | 'document' // Internal documents, PDFs, knowledge base
  | 'dataset' // Dashboards, databases, structured data
  | 'mcp'; // MCP tool results

/**
 * Processing status for real-time updates
 * Enables DeepResearch-style progressive disclosure
 */
export type CitableSourceStatus = 'pending' | 'processing' | 'complete' | 'error';

/**
 * A unified interface for citable sources across the application.
 * Used to track and display sources referenced in AI responses.
 *
 * Sources can come from:
 * - Web searches (web_search tool)
 * - Deep research (deep_research tool)
 * - RAG/knowledge base queries
 * - MCP tool results
 * - Dashboard/dataset references
 */
export interface CitableSource {
  /**
   * Unique identifier
   * Can be URL, UUID, or composite key like "dashboard-market"
   */
  id: string;

  /**
   * Source classification for UI rendering
   * Determines icon, color, and behavior
   */
  type: CitableSourceType;

  /**
   * Human-readable title/name
   * Required for display
   */
  title: string;

  /**
   * Navigation target (optional)
   * Can be:
   * - External: https://example.com/article
   * - Deep link: deep://lake/market-data/123
   * - Hash route: /#/dashboards/decision-maker
   */
  url?: string;

  /**
   * Brief description or excerpt (1-2 sentences)
   * Enriches UX with context
   */
  description?: string;

  /**
   * ISO 8601 timestamp for freshness indication
   */
  timestamp?: string;

  /**
   * Attribution for non-report sources
   */
  author?: string;

  /**
   * Processing status for real-time updates
   * Enables DeepResearch-style progressive disclosure
   */
  status?: CitableSourceStatus;

  /**
   * Extensibility escape hatch
   * System-specific data without breaking the interface
   *
   * Common patterns:
   * - sourceSystem: 'deep_research' | 'signal_rag' | 'dashboard_market' | 'web_search'
   * - tags: ['market', 'internal', 'real-time']
   * - confidence: 0.95 (for SIGNAL)
   * - practiceAreas: ['AI', 'Security'] (for Intelligence Feed)
   * - chunkId: 'chunk-456' (for RAG sources)
   * - relevanceScore: 0.89
   */
  metadata?: {
    sourceSystem?: string;
    icon?: string;
    tags?: string[];
    confidence?: number;
    practiceAreas?: string[];
    chunkId?: string;
    relevanceScore?: number;
    fullContext?: string; // For text-based sources (RAG, web search)
    [key: string]: unknown;
  };
}
