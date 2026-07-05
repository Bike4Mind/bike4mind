import { api } from '@client/app/contexts/ApiContext';
import { createOptimisticQuest } from '@client/app/utils/llm';
import { ISessionDocument } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';

export type RollCommandArgs = {
  params: string;
  currentSession: ISessionDocument;
  queryClient: QueryClient;
};

export const generateRandomDiceRoll = (): string => {
  const numDice = Math.floor(Math.random() * 19) + 2; // Random number between 2 and 20
  const polyhedralOptions = [4, 6, 8, 10, 12, 20];
  const polyhedral = polyhedralOptions[Math.floor(Math.random() * polyhedralOptions.length)];
  return `${numDice}d${polyhedral}`;
};

export const sendRollRequest = async (data: { diceSpec: string; sessionId: string }) => {
  const response = await api.post('/api/roll', data);
  return response.data;
};

export async function handleRollCommand(args: RollCommandArgs) {
  const { params, currentSession, queryClient } = args;

  const diceSpec = params || generateRandomDiceRoll();

  await createOptimisticQuest(queryClient, currentSession.id, diceSpec, async () => {
    return await sendRollRequest({ diceSpec, sessionId: currentSession.id });
  });
}
