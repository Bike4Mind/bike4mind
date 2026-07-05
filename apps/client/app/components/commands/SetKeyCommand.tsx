import { IChatHistoryItem, ISessionDocument } from '@bike4mind/common';
import { withTimeout } from '../TimeOut';
import { AxiosResponse } from 'axios';
import { api } from '@client/app/contexts/ApiContext';

export type SetKeyCommandArgs = {
  params: string;
  addMessageToSession: (message: IChatHistoryItem) => Promise<void>;
  currentSession: ISessionDocument;
};

export async function handleSetKeyCommand(args: SetKeyCommandArgs & { userId: string }) {
  const { params, currentSession, addMessageToSession } = args;
  const keySpec = params;
  const obfuscatedKey =
    keySpec.length >= 6
      ? `${keySpec.substring(0, 3)}***********************${keySpec.substring(keySpec.length - 3)}`
      : keySpec;

  console.log('keySpec:', keySpec);

  const timestamp = new Date();

  const message: IChatHistoryItem = {
    sessionId: currentSession.id,
    prompt: obfuscatedKey,
    timestamp: timestamp,
    type: 'message',
    reply: obfuscatedKey,
  };

  const keyResult = await sendSetAPIKeyRequest(keySpec);
  message.reply = keyResult;
  await addMessageToSession(message);
}

export const sendSetAPIKeyRequest = async (keySpec: string) => {
  try {
    const response = (await withTimeout(api.post('/api/api-keys/create', { keySpec }), 10000)) as AxiosResponse<
      any,
      any
    >;

    const result = response.data;

    return `API Key has been set to ${result.apiKey}.`;
  } catch (error) {
    console.error('Error in sendSetAPIKeyRequest:', error);
    return 'Server has not replied in 10 seconds, try turning it on?';
  }
};
