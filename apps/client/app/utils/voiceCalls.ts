import { api } from '@client/app/contexts/ApiContext';
import { IVoice } from '@bike4mind/common';

export const getVoiceFromServer = async (): Promise<IVoice[]> => {
  const response = await api.get(`/api/elabs/voice`);

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error('Failed to get Voice');
  }
};

export const upsertVoice = async (data: {
  keySpec: string;
  description: string;
  isActive: boolean;
}): Promise<{ result: string; success: boolean }> => {
  const response = await api.post('/api/elabs/voice', data);

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(response.data?.error);
  }
};
