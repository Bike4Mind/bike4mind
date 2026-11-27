import type { FeedbackStatus } from '@bike4mind/common';

export interface SimilarFeedbackReport {
  id: string;
  status: FeedbackStatus;
  createdAt: string;
  excerpt: string;
  similarity: number;
}

export interface SimilarFeedbackResponse {
  items: SimilarFeedbackReport[];
  limited: boolean;
}
