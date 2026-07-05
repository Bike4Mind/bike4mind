import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { useHelpFeedback, useMyRecentFeedback } from './useHelpAnalytics';

interface ArticleFeedbackEntry {
  rating: 'helpful' | 'not_helpful' | null;
  comment: string;
  reportOutdated: boolean;
  commentSent: boolean;
}

const EMPTY_ENTRY: ArticleFeedbackEntry = {
  rating: null,
  comment: '',
  reportOutdated: false,
  commentSent: false,
};

interface ArticleFeedbackStore {
  /** Feedback state keyed by slug */
  entries: Record<string, ArticleFeedbackEntry>;
  /** Slugs that have already been populated from server data */
  populatedSlugs: Set<string>;

  setRating: (slug: string, rating: 'helpful' | 'not_helpful') => void;
  setComment: (slug: string, comment: string) => void;
  setReportOutdated: (slug: string, value: boolean) => void;
  setCommentSent: (slug: string, value: boolean) => void;
  /** Populate from server data; runs once per slug */
  populateFromServer: (
    slug: string,
    data: { rating?: 'helpful' | 'not_helpful'; comment?: string; reportType?: 'outdated' }
  ) => void;
  /** Mark slug as populated even when no server data exists (prevents re-checking) */
  markPopulated: (slug: string) => void;
}

const useArticleFeedbackStore = create<ArticleFeedbackStore>((set, get) => ({
  entries: {},
  populatedSlugs: new Set(),

  setRating: (slug, rating) =>
    set(state => ({
      entries: {
        ...state.entries,
        [slug]: { ...(state.entries[slug] ?? EMPTY_ENTRY), rating },
      },
    })),

  setComment: (slug, comment) =>
    set(state => ({
      entries: {
        ...state.entries,
        [slug]: { ...(state.entries[slug] ?? EMPTY_ENTRY), comment },
      },
    })),

  setReportOutdated: (slug, value) =>
    set(state => ({
      entries: {
        ...state.entries,
        [slug]: { ...(state.entries[slug] ?? EMPTY_ENTRY), reportOutdated: value },
      },
    })),

  setCommentSent: (slug, value) =>
    set(state => ({
      entries: {
        ...state.entries,
        [slug]: { ...(state.entries[slug] ?? EMPTY_ENTRY), commentSent: value },
      },
    })),

  populateFromServer: (slug, data) => {
    const state = get();
    if (state.populatedSlugs.has(slug)) return;
    const entry: ArticleFeedbackEntry = {
      rating: data.rating ?? null,
      comment: data.comment ?? '',
      reportOutdated: data.reportType === 'outdated',
      commentSent: !!data.comment,
    };
    set({
      entries: { ...state.entries, [slug]: entry },
      populatedSlugs: new Set([...state.populatedSlugs, slug]),
    });
  },

  markPopulated: slug =>
    set(state => ({
      populatedSlugs: new Set([...state.populatedSlugs, slug]),
    })),
}));

/**
 * Shared hook for article feedback state. Consumed by both the header thumbs
 * (compact) and the bottom HelpFeedbackWidget (full). State lives in a Zustand
 * store keyed by slug so all consumers of the same slug share identical state.
 */
export function useArticleFeedbackState(slug: string) {
  const { submitFeedback } = useHelpFeedback();
  const { data: recentFeedback } = useMyRecentFeedback();

  const entry = useArticleFeedbackStore(s => s.entries[slug] ?? EMPTY_ENTRY);
  const populatedSlugs = useArticleFeedbackStore(s => s.populatedSlugs);

  // Populate from server data once per slug
  useEffect(() => {
    if (!recentFeedback || populatedSlugs.has(slug)) return;
    const { populateFromServer, markPopulated } = useArticleFeedbackStore.getState();
    const existing = recentFeedback.articleFeedback.find(f => f.slug === slug);
    if (existing) {
      populateFromServer(slug, existing);
    } else {
      markPopulated(slug);
    }
  }, [recentFeedback, slug, populatedSlugs]);

  const handleRating = useCallback(
    (value: 'helpful' | 'not_helpful') => {
      if (value === entry.rating) return;
      useArticleFeedbackStore.getState().setRating(slug, value);
      submitFeedback.mutate({ slug, rating: value });
    },
    [slug, entry.rating, submitFeedback]
  );

  const handleSubmitExtra = useCallback(() => {
    if (!entry.rating) return;
    const hasComment = entry.comment.trim().length > 0;
    if (!hasComment && !entry.reportOutdated) return;
    submitFeedback.mutate(
      {
        slug,
        rating: entry.rating,
        ...(entry.reportOutdated && { reportType: 'outdated' as const }),
        ...(hasComment && { comment: entry.comment.trim() }),
      },
      { onSuccess: () => useArticleFeedbackStore.getState().setCommentSent(slug, true) }
    );
  }, [slug, entry.rating, entry.comment, entry.reportOutdated, submitFeedback]);

  const handleEditComment = useCallback(() => {
    useArticleFeedbackStore.getState().setCommentSent(slug, false);
  }, [slug]);

  return {
    rating: entry.rating,
    comment: entry.comment,
    setComment: (value: string) => useArticleFeedbackStore.getState().setComment(slug, value),
    reportOutdated: entry.reportOutdated,
    setReportOutdated: (value: boolean) => useArticleFeedbackStore.getState().setReportOutdated(slug, value),
    commentSent: entry.commentSent,
    handleRating,
    handleSubmitExtra,
    handleEditComment,
    isPending: submitFeedback.isPending,
  };
}
