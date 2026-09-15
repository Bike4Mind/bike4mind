import { api } from '@client/app/contexts/ApiContext';
import { IPromptDocument } from '@bike4mind/common';

interface IPromptListResponse {
  data: IPromptDocument[];
}

interface IPromptInput {
  name?: string;
  template?: string;
  description?: string;
  isTemplate?: boolean;
}

export const getPromptsFromServer = async (args: { isTemplate?: boolean }) => {
  const response = await api.get<IPromptListResponse>(`/api/prompts`, { params: args });
  return response.data.data;
};

export const getPromptByNameFromServer = async (name: string): Promise<IPromptDocument> => {
  const { data } = await api.get<IPromptDocument>(`/api/prompts/get-by-name`, { params: { name } });
  return data;
};

export const createPromptOnServer = async (promptData: IPromptInput) => {
  const response = await api.post<IPromptDocument>('/api/prompts', promptData);
  return response.data;
};

export const updatePromptOnServer = async (
  promptId: string,
  updatedPromptData: IPromptInput
): Promise<IPromptDocument> => {
  const response = await api.put<IPromptDocument>(`/api/prompts/${promptId}/update`, updatedPromptData);
  return response.data;
};

export const deletePromptFromServer = async (promptId: string): Promise<void> => {
  await api.delete(`/api/prompts/${promptId}/delete`);
  return;
};
