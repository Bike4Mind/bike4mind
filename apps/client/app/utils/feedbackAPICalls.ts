import { api } from '@client/app/contexts/ApiContext';
import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import type { IFeedbackDocument, CreateFeedbackResponse } from '@bike4mind/common';
import type {
  FeedbackListParams,
  FeedbackListResponse,
  IExtendedFeedbackDocument,
} from '@client/app/components/admin/Feedback/types';

/**
 * Hard ceiling on rows a CSV export will page through. The export has to cover every row matching
 * the current filters, not just the page on screen, but it must not be able to walk an unbounded
 * collection either - so it stops here and reports the truncation rather than quietly emitting a
 * partial file.
 */
export const FEEDBACK_EXPORT_MAX_ROWS = 5000;

export const getFeedbackFromServer = async (params: FeedbackListParams): Promise<FeedbackListResponse> => {
  const response = await api.get<FeedbackListResponse>('/api/feedback', { params });
  return response.data;
};

/**
 * Pages through every report matching `filters` for the CSV export, up to FEEDBACK_EXPORT_MAX_ROWS.
 * `truncated` tells the caller the file is short so it can say so; an export that silently drops
 * rows past the cap would read as a complete one.
 */
export const getAllFeedbackForExport = async (
  filters: Omit<FeedbackListParams, 'page' | 'limit'>
): Promise<{ items: IExtendedFeedbackDocument[]; truncated: boolean }> => {
  const items: IExtendedFeedbackDocument[] = [];
  let page = 1;

  for (;;) {
    const response = await getFeedbackFromServer({ ...filters, page, limit: FEEDBACK_LIST_MAX_LIMIT });
    items.push(...response.items);

    const exhausted = items.length >= response.total || response.items.length === 0;
    if (exhausted) return { items, truncated: false };
    if (items.length >= FEEDBACK_EXPORT_MAX_ROWS) {
      return { items: items.slice(0, FEEDBACK_EXPORT_MAX_ROWS), truncated: true };
    }
    page += 1;
  }
};

export const createFeedbackOnServer = async (
  feedbackData: Partial<IFeedbackDocument>
): Promise<CreateFeedbackResponse> => {
  const response = await api.post<CreateFeedbackResponse>('/api/feedback', feedbackData);
  return response.data;
};

export const updateFeedbackOnServer = async (
  feedbackId: string,
  updatedFeedbackData: Partial<IFeedbackDocument>
): Promise<IFeedbackDocument> => {
  const response = await api.put<IFeedbackDocument>(`/api/feedback/${feedbackId}/update`, updatedFeedbackData);
  return response.data;
};

export const deleteFeedbackFromServer = async (feedbackId: string): Promise<{ msg: string } | null> => {
  const response = await api.delete(`/api/feedback/${feedbackId}/delete`);
  return response.data;
};

export const getFeedbackByIdFromServer = async (feedbackId: string): Promise<IExtendedFeedbackDocument | null> => {
  const response = await api.get<IExtendedFeedbackDocument | null>(`/api/feedback/${feedbackId}/read`);
  return response.data;
};
