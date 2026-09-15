import { api } from '@client/app/contexts/ApiContext';
import { ISubscriberDocument } from '@bike4mind/common';
import { PaginatedResponse } from '@bike4mind/common';
import axios from 'axios';

export const createSubscriber = async (data: { firstName: string; lastName: string; email: string }) => {
  const response = await axios.post('/api/subscribers/create', data);
  return response.data;
};

export const fetchSubscribers = async (params: { page?: number; limit?: number; search?: string }) => {
  const response = await api.get<PaginatedResponse<ISubscriberDocument>>('/api/subscribers', { params });
  return response.data;
};

export const fetchWaitingSubscribersCount = async () => {
  const response = await api.get<{ count: number }>('/api/subscribers/waiting-count');
  return response.data;
};

export const deleteSubscriber = async (id: string) => {
  const response = await api.delete(`/api/subscribers/${id}/delete`);
  return response.data;
};
