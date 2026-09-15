import { api } from '@client/app/contexts/ApiContext';
import { IApiKeyDocument } from '@bike4mind/common';

export const getAPIKeysFromServer = async (): Promise<IApiKeyDocument[]> => {
  const response = await api.get(`/api/api-keys`);
  return response.data;
};

export const upsertApiKey = async (data: {
  apiKey: string;
  description: string;
  type: string;
  isActive: boolean;
}): Promise<{ result: string; success: boolean }> => {
  const response = await api.post('/api/api-keys/create', data);
  return response.data;
};
