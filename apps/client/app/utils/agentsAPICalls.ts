import { api } from '@client/app/contexts/ApiContext';
import { IAgent } from '@bike4mind/common';
import { prepareAgentDataForApi } from './agentUtils';

export const getAgentsFromServer = async (
  search: string = '',
  options = {
    pagination: { page: 1, limit: 10 },
  }
) => {
  const response = await api.get<{ data: IAgent[]; hasMore: boolean; total: number }>(`/api/agents`, {
    params: {
      query: search,
      pagination: options.pagination,
      _t: Date.now(), // Cache buster
    },
  });

  return response.data;
};

export const getAgentByIdFromServer = async (agentId: string): Promise<IAgent> => {
  const response = await api.get<IAgent>(`/api/agents/${agentId}`);
  return response.data;
};

export const createAgentToServer = async (agentData: Partial<IAgent>): Promise<IAgent> => {
  try {
    // If agentData includes currentCredits > 0 and useOwnCredits=true, the
    // backend should deduct these credits from the user's balance.
    const preparedData = prepareAgentDataForApi(agentData);
    const response = await api.post<IAgent>(`/api/agents`, preparedData);
    return response.data;
  } catch (error) {
    console.error('API Error creating agent:', error);
    throw error;
  }
};

export const updateAgentToServer = async (agentData: Partial<IAgent>): Promise<IAgent> => {
  const preparedData = prepareAgentDataForApi(agentData);
  const response = await api.put<IAgent>(`/api/agents/${agentData.id}`, preparedData);
  return response.data;
};

export const deleteAgentFromServer = async (agentId: string): Promise<void> => {
  await api.delete(`/api/agents/${agentId}`);
};

export const generateAgentDescription = async (agentId: string): Promise<string> => {
  try {
    const response = await api.post<{ description: string }>(`/api/agents/${agentId}/generate-description`);
    return response.data.description;
  } catch (error) {
    console.error('API Error generating agent description:', error);
    throw error;
  }
};

export const generateAgentAvatar = async (
  agentId: string,
  imageModel?: string
): Promise<{ portraitUrl: string; generationPrompt: string }> => {
  try {
    const response = await api.post<{ portraitUrl: string; generationPrompt: string }>(
      `/api/agents/${agentId}/generate-avatar`,
      { imageModel }
    );
    return response.data;
  } catch (error) {
    console.error('API Error generating agent avatar:', error);
    throw error;
  }
};

export const generateSystemPrompt = async (
  agentId: string
): Promise<{ success: boolean; systemPrompt: string; message: string }> => {
  try {
    const response = await api.post<{ success: boolean; systemPrompt: string; message: string }>(
      `/api/agents/${agentId}/generate-system-prompt`
    );
    return response.data;
  } catch (error) {
    console.error('API Error generating system prompt:', error);
    throw error;
  }
};

export const enhanceAgentField = async (
  agentId: string,
  fieldName: string,
  currentValue: string,
  agentName?: string
): Promise<{ success: boolean; enhancedValue: string; message: string }> => {
  try {
    const response = await api.post<{ success: boolean; enhancedValue: string; message: string }>(
      `/api/agents/${agentId}/enhance-field`,
      { fieldName, currentValue, agentName }
    );
    return response.data;
  } catch (error) {
    console.error('API Error enhancing agent field:', error);
    throw error;
  }
};
