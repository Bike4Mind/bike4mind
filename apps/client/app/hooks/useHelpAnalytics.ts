import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

type HelpEventPayload = {
  type: 'article_view' | 'search' | 'chat_query';
  slug?: string;
  articleTitle?: string;
  searchQuery?: string;
  searchResultCount?: number;
  chatQuestion?: string;
};

/** Fire-and-forget POST - swallows errors so analytics never breaks the UI */
function postEvent(payload: HelpEventPayload) {
  return api.post('/api/help/event', payload).catch(() => {
    // Swallow analytics errors - never break the UI
  });
}

/**
 * Hook for tracking help center analytics events (fire-and-forget).
 * Provides debounced methods for article views, search tracking, and chat queries.
 * For feedback mutations (which need isPending state), use useHelpFeedback instead.
 */
export function useHelpAnalytics() {
  const queryClient = useQueryClient();
  // Track which slugs have already been viewed this session to avoid duplicate views
  const viewedSlugsRef = useRef<Set<string>>(new Set());
  // Debounce timer for search tracking
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up pending search debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  // Stable callbacks - no dependency on mutation objects so they never change identity
  const trackArticleView = useCallback(
    (slug: string, title?: string) => {
      if (viewedSlugsRef.current.has(slug)) return;
      viewedSlugsRef.current.add(slug);
      // Refresh the recently-viewed list so a newly viewed article shows up without waiting for staleTime.
      postEvent({ type: 'article_view', slug, articleTitle: title }).finally(() => {
        queryClient.invalidateQueries({ queryKey: ['help', 'recently-viewed'] });
      });
    },
    [queryClient]
  );

  const trackSearch = useCallback((query: string, resultCount: number) => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    if (!query.trim()) return;
    searchTimerRef.current = setTimeout(() => {
      postEvent({ type: 'search', searchQuery: query, searchResultCount: resultCount });
    }, 1000);
  }, []);

  const trackChatQuery = useCallback((question: string) => {
    postEvent({ type: 'chat_query', chatQuestion: question });
  }, []);

  return {
    trackArticleView,
    trackSearch,
    trackChatQuery,
  };
}

export interface MyRecentArticleFeedback {
  slug: string;
  rating?: 'helpful' | 'not_helpful';
  reportType?: 'outdated';
  comment?: string;
  createdAt: string;
}

export interface MyRecentChatFeedback {
  chatQuestion: string;
  chatAnswer: string;
  rating: 'helpful' | 'not_helpful';
  comment?: string;
  createdAt: string;
}

interface MyRecentFeedbackData {
  articleFeedback: MyRecentArticleFeedback[];
  chatFeedback: MyRecentChatFeedback[];
}

/**
 * Hook for fetching the current user's recent feedback (last 10 minutes).
 * Used to pre-populate feedback UI on re-navigation.
 */
export function useMyRecentFeedback() {
  return useQuery<MyRecentFeedbackData>({
    queryKey: ['help', 'my-feedback'],
    queryFn: async () => {
      const { data } = await api.get<MyRecentFeedbackData>('/api/help/my-feedback');
      return data;
    },
    staleTime: 2 * 60 * 1000,
  });
}

export interface MyRecentlyViewedArticle {
  slug: string;
  articleTitle?: string;
  viewedAt: string;
}

/**
 * Hook for fetching the current user's recently viewed help articles.
 * Backed by `GET /api/help/recently-viewed`, which de-dupes the user's `article_view` events.
 */
export function useMyRecentlyViewed() {
  return useQuery<{ recentlyViewed: MyRecentlyViewedArticle[] }>({
    queryKey: ['help', 'recently-viewed'],
    queryFn: async () => {
      const { data } = await api.get<{ recentlyViewed: MyRecentlyViewedArticle[] }>('/api/help/recently-viewed');
      return data;
    },
    staleTime: 60 * 1000,
  });
}

/**
 * Hook for submitting help feedback (article and chat).
 * Uses useMutation so callers get isPending state for disabling buttons.
 * Separate from useHelpAnalytics to avoid creating mutation instances
 * in components that only need fire-and-forget tracking.
 */
export function useHelpFeedback() {
  const queryClient = useQueryClient();

  const feedbackMutation = useMutation({
    mutationFn: async (payload: {
      slug: string;
      rating?: 'helpful' | 'not_helpful';
      reportType?: 'outdated';
      comment?: string;
    }) => {
      const { data } = await api.post('/api/help/feedback', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['help', 'my-feedback'] });
    },
  });

  const chatFeedbackMutation = useMutation({
    mutationFn: async (payload: {
      chatQuestion: string;
      chatAnswer: string;
      rating: 'helpful' | 'not_helpful';
      comment?: string;
    }) => {
      const { data } = await api.post('/api/help/chat-feedback', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['help', 'my-feedback'] });
    },
  });

  return {
    submitFeedback: feedbackMutation,
    submitChatFeedback: chatFeedbackMutation,
  };
}
