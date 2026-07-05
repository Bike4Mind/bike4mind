import { api } from '@client/app/contexts/ApiContext';
import { IInboxDocument } from '@bike4mind/common';

export const readInboxMessages = async (ids: string[]) => {
  const response = await api.post('/api/inbox/read', { ids });
  return response.data;
};

export const fetchInbox = async (userId?: string): Promise<IInboxDocument[]> => {
  try {
    const response = await api.get('/api/inbox', {
      params: userId ? { userId } : {},
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching Inbox:', error);
    return [];
  }
};

export const sendMessage = async (data: { title: string; message: string; receiver: string }) => {
  const response = await api.post('/api/inbox/create', data);
  return response.data;
};

export const sendSystemMessage = async (data: { title: string; message: string; receiverId: string }) => {
  const response = await api.post('/api/inbox/admin-send', data);
  return response.data;
};

export const getInboxFromServer = async (): Promise<IInboxDocument[]> => {
  const response = await api.get<IInboxDocument[]>(`/api/inbox`);
  return response.data;
};

export const deleteInboxItemFromServer = async (inboxId: string): Promise<{ msg: string } | null> => {
  const response = await api.delete(`/api/inbox/${inboxId}/delete`);
  return response.data;
};
