import { api } from '@client/app/contexts/ApiContext';
import { IChatHistoryItem, ISessionDocument } from '@bike4mind/common';

export type ModelsCommandArgs = {
  addMessageToSession: (message: IChatHistoryItem) => void;
  currentSession: ISessionDocument;
};

export const fetchAvailableModels = async (): Promise<string[]> => {
  try {
    const response = await api.get('/api/models').then(res => res.data);
    return response.models.data.map((model: { id: string }) => model.id).sort();
  } catch (error) {
    console.error('Error calling /models:', error);
    return [];
  }
};

export async function handleModelsCommand(args: ModelsCommandArgs) {
  const { addMessageToSession, currentSession } = args;

  const availableModels = await fetchAvailableModels();

  console.log('handleModelsCommand: ', availableModels);

  const message: IChatHistoryItem = {
    sessionId: currentSession.id,
    timestamp: new Date(),
    type: 'system' as const,
    prompt: 'Fetching models',
    reply: availableModels.join('\n'),
    oob: '',
  };

  addMessageToSession(message);
}
