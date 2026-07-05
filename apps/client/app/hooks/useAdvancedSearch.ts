/**
 * Advanced Notebook Search Hook
 *
 * Centralized state management for the advanced notebook search feature.
 * Provides a clean API for managing search query, filters, workspaces, and UI state.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  NotebookSearchFilters,
  DEFAULT_SEARCH_FILTERS,
  DateRange,
  DateRangePreset,
  DATE_RANGE_PRESETS,
  SearchWorkspace,
  hasActiveFilters,
  countActiveFilters,
} from '@client/app/types/NotebookSearchTypes';

/**
 * Debug info for semantic search results
 */
export interface SemanticSearchScore {
  sessionId: string;
  sessionName?: string;
  maxSimilarity: number;
  matchingMessages: number;
  bestMatch?: {
    similarity: number;
    snippet: string;
  };
}

export interface SemanticSearchDebugInfo {
  query: string;
  correctedQuery?: string;
  queryExpansionTimeMs?: number;
  minSimilarity: number;
  hybridMode: boolean;
  keywords: string[];
  keywordMatchCount: number | null;
  messagesWithEmbedding: number;
  messagesGenerated: number;
  scores: SemanticSearchScore[];
  reRankingUsed?: boolean;
  reRankingTimeMs?: number;
  candidatesReRanked?: number;
  candidatesFiltered?: number;
}

/**
 * Extended search state including semantic search
 */
interface NotebookSearchState {
  query: string;
  filters: NotebookSearchFilters;
  activeWorkspace: string | null;
  isDrawerOpen: boolean;
  isAnalyticsOpen: boolean;
  // Semantic search state
  semanticQuery: string;
  semanticResults: string[] | null; // Session IDs from semantic search
  semanticDebugInfo: SemanticSearchDebugInfo | null; // Debug info with scores and snippets
  isSemanticSearching: boolean;
  semanticSearchError: string | null;
  useReRanking: boolean; // LLM re-ranking for quality verification
}

/**
 * Actions available for the advanced search store
 */
interface AdvancedSearchActions {
  // Query management
  setQuery: (query: string) => void;
  clearQuery: () => void;

  // Filter management
  setFilters: (filters: Partial<NotebookSearchFilters>) => void;
  resetFilters: () => void;
  toggleFilter: (filterKey: keyof NotebookSearchFilters) => void;

  // Tag filters
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
  setTags: (tags: string[]) => void;
  toggleTagFilterMode: () => void;

  // Model filters
  addModel: (model: string) => void;
  removeModel: (model: string) => void;
  setModels: (models: string[]) => void;

  // Date range
  setDateRange: (range: DateRange) => void;
  setDateRangePreset: (preset: DateRangePreset) => void;
  clearDateRange: () => void;

  // Boolean toggles
  toggleFavoritesOnly: () => void;
  toggleExcludeAutoNamed: () => void;
  toggleHasSummary: () => void;
  toggleHasArtifacts: () => void;
  toggleHasFiles: () => void;

  // Category filters
  setSourceType: (type: NotebookSearchFilters['sourceType']) => void;
  setContentSize: (size: NotebookSearchFilters['contentSize']) => void;

  // Workspace management
  setActiveWorkspace: (workspaceId: string | null) => void;
  loadWorkspace: (workspace: SearchWorkspace) => void;
  saveCurrentAsWorkspace: (name: string, description?: string) => SearchWorkspace;

  // UI state
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  openAnalytics: () => void;
  closeAnalytics: () => void;
  toggleAnalytics: () => void;

  // Utility
  hasActiveFilters: () => boolean;
  getActiveFilterCount: () => number;
  clearAll: () => void;

  // Semantic search
  setSemanticQuery: (query: string) => void;
  setSemanticResults: (results: string[] | null) => void;
  setSemanticDebugInfo: (debugInfo: SemanticSearchDebugInfo | null) => void;
  setIsSemanticSearching: (isSearching: boolean) => void;
  setSemanticSearchError: (error: string | null) => void;
  clearSemanticSearch: () => void;
  toggleReRanking: () => void;
}

/**
 * Combined store type
 */
type AdvancedSearchStore = NotebookSearchState & AdvancedSearchActions;

/**
 * Initial state for the search store
 */
const initialState: NotebookSearchState = {
  query: '',
  filters: DEFAULT_SEARCH_FILTERS,
  activeWorkspace: null,
  isDrawerOpen: false,
  isAnalyticsOpen: false,
  // Semantic search initial state
  semanticQuery: '',
  semanticResults: null,
  semanticDebugInfo: null,
  isSemanticSearching: false,
  semanticSearchError: null,
  useReRanking: false,
};

/**
 * Advanced Search Zustand Store
 *
 * Persists search state (except UI state) to localStorage for better UX.
 * Users can close the app and resume their search where they left off.
 */
export const useAdvancedSearch = create<AdvancedSearchStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Query management
      setQuery: query => set({ query }),
      clearQuery: () => set({ query: '' }),

      // Filter management
      setFilters: partialFilters =>
        set(state => ({
          filters: { ...state.filters, ...partialFilters },
        })),

      resetFilters: () =>
        set({
          filters: DEFAULT_SEARCH_FILTERS,
          activeWorkspace: null,
        }),

      toggleFilter: filterKey => {
        const currentValue = get().filters[filterKey];
        if (typeof currentValue === 'boolean') {
          set(state => ({
            filters: {
              ...state.filters,
              [filterKey]: !currentValue,
            },
          }));
        }
      },

      // Tag filters
      addTag: tag => {
        const currentTags = get().filters.tags;
        if (!currentTags.includes(tag)) {
          set(state => ({
            filters: {
              ...state.filters,
              tags: [...currentTags, tag],
            },
          }));
        }
      },

      removeTag: tag =>
        set(state => ({
          filters: {
            ...state.filters,
            tags: state.filters.tags.filter(t => t !== tag),
          },
        })),

      setTags: tags =>
        set(state => ({
          filters: {
            ...state.filters,
            tags,
          },
        })),

      toggleTagFilterMode: () =>
        set(state => ({
          filters: {
            ...state.filters,
            tagFilterMode: state.filters.tagFilterMode === 'any' ? 'all' : 'any',
          },
        })),

      // Model filters
      addModel: model => {
        const currentModels = get().filters.models;
        if (!currentModels.includes(model)) {
          set(state => ({
            filters: {
              ...state.filters,
              models: [...currentModels, model],
            },
          }));
        }
      },

      removeModel: model =>
        set(state => ({
          filters: {
            ...state.filters,
            models: state.filters.models.filter(m => m !== model),
          },
        })),

      setModels: models =>
        set(state => ({
          filters: {
            ...state.filters,
            models,
          },
        })),

      // Date range
      setDateRange: range =>
        set(state => ({
          filters: {
            ...state.filters,
            dateRange: range,
          },
        })),

      setDateRangePreset: preset => {
        const range = DATE_RANGE_PRESETS[preset].getDates();
        set(state => ({
          filters: {
            ...state.filters,
            dateRange: range,
          },
        }));
      },

      clearDateRange: () =>
        set(state => ({
          filters: {
            ...state.filters,
            dateRange: { from: null, to: null },
          },
        })),

      // Boolean toggles
      toggleFavoritesOnly: () =>
        set(state => ({
          filters: {
            ...state.filters,
            favoritesOnly: !state.filters.favoritesOnly,
          },
        })),

      toggleExcludeAutoNamed: () =>
        set(state => ({
          filters: {
            ...state.filters,
            excludeAutoNamed: !state.filters.excludeAutoNamed,
          },
        })),

      toggleHasSummary: () =>
        set(state => ({
          filters: {
            ...state.filters,
            hasSummary: !state.filters.hasSummary,
          },
        })),

      toggleHasArtifacts: () =>
        set(state => ({
          filters: {
            ...state.filters,
            hasArtifacts: !state.filters.hasArtifacts,
          },
        })),

      toggleHasFiles: () =>
        set(state => ({
          filters: {
            ...state.filters,
            hasFiles: !state.filters.hasFiles,
          },
        })),

      // Category filters
      setSourceType: type =>
        set(state => ({
          filters: {
            ...state.filters,
            sourceType: type,
          },
        })),

      setContentSize: size =>
        set(state => ({
          filters: {
            ...state.filters,
            contentSize: size,
          },
        })),

      // Workspace management
      setActiveWorkspace: workspaceId => set({ activeWorkspace: workspaceId }),

      loadWorkspace: workspace => {
        set({
          query: workspace.query,
          filters: workspace.filters,
          activeWorkspace: workspace.id,
        });
      },

      saveCurrentAsWorkspace: (name, description) => {
        const state = get();
        const workspace: SearchWorkspace = {
          id: `workspace-${Date.now()}`,
          name,
          description,
          userId: '', // Will be set by API
          filters: state.filters,
          query: state.query,
          createdAt: new Date(),
          updatedAt: new Date(),
          isSmartWorkspace: false,
        };
        set({ activeWorkspace: workspace.id });
        return workspace;
      },

      // UI state
      openDrawer: () => set({ isDrawerOpen: true }),
      closeDrawer: () => set({ isDrawerOpen: false }),
      toggleDrawer: () => set(state => ({ isDrawerOpen: !state.isDrawerOpen })),
      openAnalytics: () => set({ isAnalyticsOpen: true }),
      closeAnalytics: () => set({ isAnalyticsOpen: false }),
      toggleAnalytics: () => set(state => ({ isAnalyticsOpen: !state.isAnalyticsOpen })),

      // Utility
      hasActiveFilters: () => hasActiveFilters(get().filters),
      getActiveFilterCount: () => countActiveFilters(get().filters),

      clearAll: () =>
        set({
          query: '',
          filters: DEFAULT_SEARCH_FILTERS,
          activeWorkspace: null,
          semanticQuery: '',
          semanticResults: null,
          semanticDebugInfo: null,
          isSemanticSearching: false,
          semanticSearchError: null,
        }),

      // Semantic search
      setSemanticQuery: query => set({ semanticQuery: query }),
      setSemanticResults: results => set({ semanticResults: results }),
      setSemanticDebugInfo: debugInfo => set({ semanticDebugInfo: debugInfo }),
      setIsSemanticSearching: isSearching => set({ isSemanticSearching: isSearching }),
      setSemanticSearchError: error => set({ semanticSearchError: error }),
      clearSemanticSearch: () =>
        set({
          semanticQuery: '',
          semanticResults: null,
          semanticDebugInfo: null,
          isSemanticSearching: false,
          semanticSearchError: null,
        }),
      toggleReRanking: () => set(state => ({ useReRanking: !state.useReRanking })),
    }),
    {
      name: 'advanced-search-storage', // localStorage key
      // Only persist search state, not UI state (drawer/modal open states)
      partialize: state => ({
        filters: state.filters,
        activeWorkspace: state.activeWorkspace,
      }),
      // Custom storage to handle Date serialization/deserialization
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (!str) return null;
          const data = JSON.parse(str);
          // Convert date strings back to Date objects
          if (data.state?.filters?.dateRange) {
            if (data.state.filters.dateRange.from) {
              data.state.filters.dateRange.from = new Date(data.state.filters.dateRange.from);
            }
            if (data.state.filters.dateRange.to) {
              data.state.filters.dateRange.to = new Date(data.state.filters.dateRange.to);
            }
          }
          return data;
        },
        setItem: (name, value) => {
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: name => {
          localStorage.removeItem(name);
        },
      },
    }
  )
);

/**
 * Selector hooks for common use cases
 */

// Get just the search query
export const useSearchQuery = () => useAdvancedSearch(state => state.query);

// Get just the filters
export const useSearchFilters = () => useAdvancedSearch(state => state.filters);

// Get just the drawer state
export const useSearchDrawer = () =>
  useAdvancedSearch(
    useShallow(state => ({
      isOpen: state.isDrawerOpen,
      open: state.openDrawer,
      close: state.closeDrawer,
      toggle: state.toggleDrawer,
    }))
  );

// Get just the analytics state
export const useSearchAnalytics = () =>
  useAdvancedSearch(
    useShallow(state => ({
      isOpen: state.isAnalyticsOpen,
      open: state.openAnalytics,
      close: state.closeAnalytics,
      toggle: state.toggleAnalytics,
    }))
  );

// Get active filter info
export const useActiveFilters = () =>
  useAdvancedSearch(
    useShallow(state => ({
      hasActive: state.hasActiveFilters(),
      count: state.getActiveFilterCount(),
      filters: state.filters,
      reset: state.resetFilters,
    }))
  );

// Get semantic search state
export const useSemanticSearchState = () =>
  useAdvancedSearch(
    useShallow(state => ({
      query: state.semanticQuery,
      results: state.semanticResults,
      debugInfo: state.semanticDebugInfo,
      isSearching: state.isSemanticSearching,
      error: state.semanticSearchError,
      useReRanking: state.useReRanking,
      setQuery: state.setSemanticQuery,
      setResults: state.setSemanticResults,
      setDebugInfo: state.setSemanticDebugInfo,
      setIsSearching: state.setIsSemanticSearching,
      setError: state.setSemanticSearchError,
      clear: state.clearSemanticSearch,
      toggleReRanking: state.toggleReRanking,
    }))
  );
