import { api } from '@client/app/contexts/ApiContext';
import { IFeedbackDocument } from '@bike4mind/common';

export const getFeedbackFromServer = async () => {
  const response = await api.get<IFeedbackDocument[]>(`/api/feedback`);
  return response.data;
};

export const createFeedbackOnServer = async (feedbackData: Partial<IFeedbackDocument>) => {
  console.log('feedbackData', feedbackData);
  const response = await api.post<IFeedbackDocument>('/api/feedback', feedbackData);
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

export const getFeedbackByIdFromServer = async (feedbackId: string): Promise<IFeedbackDocument | null> => {
  const response = await api.get<IFeedbackDocument | null>(`/api/feedback/${feedbackId}/read`);
  return response.data;
};
