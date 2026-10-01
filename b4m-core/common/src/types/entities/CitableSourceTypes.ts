import type { WebSearchPlace } from '../../constants/locationMap';

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
 * Where a cited internal file came from, for the chip label.
 * - `lake`: the file sits in these lakes (non-empty; a file can be in several).
 * - `library`: no lake attribution; `owned` is whether the asker owns the file.
 */
export type CitableSourceOrigin =
  { kind: 'lake'; lakes: Array<{ id: string; name: string }> } | { kind: 'library'; owned: boolean };

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
    /**
     * Primary image for the source, same as `images[0]`. Set by web_search whenever the provider
     * supplied one - NOT a signal that the user asked for a visual answer, and not currently read
     * by any renderer. Absent means the provider gave no picture.
     */
    thumbnail?: string;
    /**
     * Every image the provider supplied for this source, most representative first, capped at 4.
     * These persist with the quest, so they are a small but real addition to every stored web hit.
     */
    images?: string[];
    /**
     * Ids of the other cited sources this one provably disagrees with, from the retrieval-time
     * conflict detector (#3041, buildRetrievalConflictSignal). Present only on the chips of a
     * witness pair, and only for the kinds classified as able to ASSERT disagreement - the rest
     * are "worth a human's eye", so the UI must present even these as heuristic rather than proven.
     *
     * Ids, never excerpts: these are `fabFileId`s already carried unredacted at `citables[].id`, so
     * this stays out of the owner-only egress list that `fullContext` sits on. Adding prose evidence
     * here later would change that classification - see promptMetaRedaction.ts.
     */
    conflictsWith?: string[];
    /**
     * Where the chip's file came from, which is what the chip label is built from. Absent on legacy
     * chips and on agent-scoped KB chips, where the UI falls back to "Data Lake". `owned` is
     * relative to the user whose retrieval produced the chip (the conversation owner), not to
     * whoever views it later.
     */
    sourceOrigin?: CitableSourceOrigin;
    /**
     * A place web_search found with provider coordinates, for the inline `b4m_map` widget. The map
     * takes its pins from here only - see WebSearchPlace.
     */
    place?: WebSearchPlace;
    [key: string]: unknown;
  };
}
