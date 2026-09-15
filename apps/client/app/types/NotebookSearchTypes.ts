/**
 * Advanced Notebook Search Type Definitions
 *
 * Comprehensive type system for the Advanced Notebook Search & Analytics feature.
 * Supports multi-field search, advanced filtering, workspaces, and analytics.
 */

/**
 * Date range preset options for quick filtering
 */
export type DateRangePreset = 'today' | 'last7days' | 'last30days' | 'thisYear' | 'custom';

/**
 * Content size categories based on conversation length
 */
export type ContentSize = 'any' | 'single' | 'brief' | 'short' | 'medium' | 'substantial' | 'deep';

/**
 * Notebook source type filter
 */
export type SourceType = 'all' | 'original' | 'cloned' | 'forked';

/**
 * Tag filter logic mode
 */
export type TagFilterMode = 'any' | 'all'; // OR vs AND logic

/**
 * Date range filter
 */
export interface DateRange {
  from: Date | null;
  to: Date | null;
  preset?: DateRangePreset;
}

/**
 * Comprehensive search filters for notebooks
 */
export interface NotebookSearchFilters {
  // Multi-select filters
  tags: string[];
  tagFilterMode: TagFilterMode; // AND or OR
  models: string[]; // AI model filters (e.g., 'claude-opus', 'gpt-4')

  // Date filtering
  dateRange: DateRange;

  // Boolean toggles
  favoritesOnly: boolean;
  excludeAutoNamed: boolean;
  hasSummary: boolean;
  hasArtifacts: boolean;
  hasFiles: boolean;

  // Category filters
  sourceType: SourceType;
  contentSize: ContentSize;
}

/**
 * Complete search state including query and filters
 */
export interface NotebookSearchState {
  query: string; // Main search query
  filters: NotebookSearchFilters;
  activeWorkspace: string | null; // Currently active saved workspace
  isDrawerOpen: boolean; // Advanced search drawer visibility
  isAnalyticsOpen: boolean; // Analytics modal visibility
}

/**
 * Search results metadata
 */
export interface SearchResultsMetadata {
  total: number; // Total matching items (notebooks + agents + projects)
  notebooks: number; // Total notebooks
  agents: number; // Total agents
  projects: number; // Total projects
  breakdown: {
    original: number; // Original notebooks
    cloned: number; // Cloned notebooks
    forked: number; // Forked notebooks
    shared: number; // Shared notebooks
  };
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Saved search workspace
 */
export interface SearchWorkspace {
  id: string;
  name: string;
  description?: string;
  userId: string;
  filters: NotebookSearchFilters;
  query: string;
  createdAt: Date;
  updatedAt: Date;
  isSmartWorkspace: boolean; // Auto-generated vs user-created
}

/**
 * Analytics data structures
 */

export interface TagDistribution {
  tag: string;
  count: number;
  strength: number; // Cumulative strength across all notebooks
}

export interface ModelUsageStats {
  model: string;
  modelName: string; // Human-readable name
  count: number;
  percentage: number;
}

export interface ActivityDataPoint {
  date: string; // ISO date string
  count: number;
}

export interface ContentSizeDistribution {
  quick: number; // < 10 messages
  medium: number; // 10-50 messages
  deep: number; // > 50 messages
}

export interface NotebookAnalytics {
  totalCount: number;
  breakdown: {
    original: number;
    cloned: number;
    forked: number;
    shared: number;
  };
  tagDistribution: TagDistribution[];
  modelUsage: ModelUsageStats[];
  activityByDate: ActivityDataPoint[];
  activityByDayOfWeek: { day: string; count: number }[];
  activityByHour: { hour: number; count: number }[];
  contentSizeDistribution: ContentSizeDistribution;
  recentActivity: {
    last7Days: number;
    last30Days: number;
  };
  averageMessagesPerNotebook: number;
  averageTagsPerNotebook: number;
}

/**
 * Export format options
 */
export type ExportFormat = 'csv' | 'json' | 'markdown';

/**
 * Export configuration
 */
export interface ExportConfig {
  format: ExportFormat;
  includeFields: {
    title: boolean;
    summary: boolean;
    tags: boolean;
    createdDate: boolean;
    updatedDate: boolean;
    model: boolean;
    messageCount: boolean;
    artifacts: boolean;
    files: boolean;
  };
  searchQuery?: string; // Include original search query in export
  filters?: NotebookSearchFilters; // Include applied filters in export
}

/**
 * Search history entry
 */
export interface SearchHistoryEntry {
  id: string;
  query: string;
  filters: NotebookSearchFilters;
  timestamp: Date;
  resultCount: number;
}

/**
 * AI-powered search suggestion
 */
export interface SearchSuggestion {
  id: string;
  title: string;
  description: string;
  suggestedQuery?: string;
  suggestedFilters?: Partial<NotebookSearchFilters>;
  reason: string; // Why this suggestion is being made
}

/**
 * Bulk operation types
 */
export type BulkOperationType =
  | 'tag'
  | 'share'
  | 'addToProject'
  | 'export'
  | 'archive'
  | 'delete'
  | 'favorite'
  | 'unfavorite';

/**
 * Bulk operation configuration
 */
export interface BulkOperationConfig {
  type: BulkOperationType;
  notebookIds: string[];
  payload?: {
    tags?: string[]; // For tag operation
    projectId?: string; // For addToProject
    exportConfig?: ExportConfig; // For export
    shareWith?: string[]; // For share operation
  };
}

/**
 * Default/initial filter state
 */
export const DEFAULT_SEARCH_FILTERS: NotebookSearchFilters = {
  tags: [],
  tagFilterMode: 'any',
  models: [],
  dateRange: {
    from: null,
    to: null,
  },
  favoritesOnly: false,
  excludeAutoNamed: false,
  hasSummary: false,
  hasArtifacts: false,
  hasFiles: false,
  sourceType: 'all',
  contentSize: 'any',
};

/**
 * Content size thresholds (message counts)
 */
export const CONTENT_SIZE_THRESHOLDS = {
  single: { min: 1, max: 1 },
  brief: { min: 2, max: 4 },
  short: { min: 5, max: 10 },
  medium: { min: 11, max: 20 },
  substantial: { min: 21, max: 50 },
  deep: { min: 51, max: Infinity },
};

/**
 * Date range preset configurations
 */
export const DATE_RANGE_PRESETS: Record<DateRangePreset, { label: string; getDates: () => DateRange }> = {
  today: {
    label: 'Today',
    getDates: () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return { from: today, to: tomorrow, preset: 'today' };
    },
  },
  last7days: {
    label: 'Last 7 Days',
    getDates: () => {
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      return { from: sevenDaysAgo, to: today, preset: 'last7days' };
    },
  },
  last30days: {
    label: 'Last 30 Days',
    getDates: () => {
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      return { from: thirtyDaysAgo, to: today, preset: 'last30days' };
    },
  },
  thisYear: {
    label: 'This Year',
    getDates: () => {
      const now = new Date();
      const startOfYear = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      return { from: startOfYear, to: endOfYear, preset: 'thisYear' };
    },
  },
  custom: {
    label: 'Custom',
    getDates: () => ({ from: null, to: null, preset: 'custom' }),
  },
};

/**
 * Helper function to check if filters are active (non-default)
 */
export function hasActiveFilters(filters: NotebookSearchFilters): boolean {
  return (
    filters.tags.length > 0 ||
    filters.models.length > 0 ||
    filters.dateRange.from !== null ||
    filters.dateRange.to !== null ||
    filters.favoritesOnly ||
    filters.excludeAutoNamed ||
    filters.hasSummary ||
    filters.hasArtifacts ||
    filters.hasFiles ||
    filters.sourceType !== 'all' ||
    filters.contentSize !== 'any'
  );
}

/**
 * Helper function to count active filters
 */
export function countActiveFilters(filters: NotebookSearchFilters): number {
  let count = 0;
  if (filters.tags.length > 0) count++;
  if (filters.models.length > 0) count++;
  if (filters.dateRange.from || filters.dateRange.to) count++;
  if (filters.favoritesOnly) count++;
  if (filters.excludeAutoNamed) count++;
  if (filters.hasSummary) count++;
  if (filters.hasArtifacts) count++;
  if (filters.hasFiles) count++;
  if (filters.sourceType !== 'all') count++;
  if (filters.contentSize !== 'any') count++;
  return count;
}

/**
 * Helper function to get human-readable filter summary
 */
export function getFilterSummary(filters: NotebookSearchFilters): string[] {
  const summary: string[] = [];

  if (filters.tags.length > 0) {
    const tagText =
      filters.tagFilterMode === 'all'
        ? `Tags (all): ${filters.tags.join(', ')}`
        : `Tags (any): ${filters.tags.join(', ')}`;
    summary.push(tagText);
  }

  if (filters.models.length > 0) {
    summary.push(`Models: ${filters.models.join(', ')}`);
  }

  if (filters.dateRange.from || filters.dateRange.to) {
    const preset = filters.dateRange.preset;
    if (preset && preset !== 'custom') {
      summary.push(DATE_RANGE_PRESETS[preset].label);
    } else {
      const from = filters.dateRange.from?.toLocaleDateString() || 'Start';
      const to = filters.dateRange.to?.toLocaleDateString() || 'Now';
      summary.push(`${from} - ${to}`);
    }
  }

  if (filters.favoritesOnly) summary.push('Favorites only');
  if (filters.excludeAutoNamed) summary.push('Exclude auto-named');
  if (filters.hasSummary) summary.push('Has summary');
  if (filters.hasArtifacts) summary.push('Has artifacts');
  if (filters.hasFiles) summary.push('Has files');

  if (filters.sourceType !== 'all') {
    summary.push(`Source: ${filters.sourceType}`);
  }

  if (filters.contentSize !== 'any') {
    summary.push(`Size: ${filters.contentSize}`);
  }

  return summary;
}
