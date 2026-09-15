import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface HelpAnalyticsFilters {
  dateFrom?: string;
  dateTo?: string;
}

export interface HelpAnalyticsTopArticle {
  slug: string;
  title: string | null;
  viewCount: number;
}

export interface HelpAnalyticsSearchGap {
  query: string;
  count: number;
  lastSearched: string;
}

export interface HelpAnalyticsFeedbackSummary {
  slug: string;
  helpful: number;
  notHelpful: number;
  outdated: number;
  totalFeedback: number;
}

export interface HelpAnalyticsChatTopic {
  question: string;
  count: number;
  lastAsked: string;
}

export interface HelpAnalyticsOverview {
  totalViews: number;
  totalSearches: number;
  totalFeedback: number;
  totalChatQueries: number;
  uniqueArticlesViewed: number;
  totalChatFeedback: number;
}

export interface HelpAnalyticsRecentFeedback {
  slug: string;
  rating?: 'helpful' | 'not_helpful';
  reportType?: 'outdated';
  comment?: string;
  userId: string;
  createdAt: string;
}

export interface HelpAnalyticsChatFeedback {
  chatQuestion: string;
  chatAnswer: string;
  rating: 'helpful' | 'not_helpful';
  comment?: string;
  userId: string;
  createdAt: string;
}

export interface HelpAnalyticsData {
  topArticles: HelpAnalyticsTopArticle[];
  searchGaps: HelpAnalyticsSearchGap[];
  feedbackSummary: HelpAnalyticsFeedbackSummary[];
  chatTopics: HelpAnalyticsChatTopic[];
  overview: HelpAnalyticsOverview;
  recentFeedback: HelpAnalyticsRecentFeedback[];
  chatFeedback: HelpAnalyticsChatFeedback[];
}

export const useHelpAnalyticsData = (filters?: HelpAnalyticsFilters) => {
  return useQuery<HelpAnalyticsData>({
    queryKey: ['admin', 'help-analytics', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.dateFrom) params.set('dateFrom', filters.dateFrom);
      if (filters?.dateTo) params.set('dateTo', filters.dateTo);
      // Send the user's timezone offset so the server can interpret date strings
      // as local calendar days rather than UTC midnight
      params.set('tzOffset', String(new Date().getTimezoneOffset()));
      const url = `/api/admin/help-analytics?${params.toString()}`;
      const res = await api.get<HelpAnalyticsData>(url);
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
};
