import type { IpcMain } from 'electron';
import type { ChatSessionSummary } from '@shared/chat';
import { parseGenerationInput, type GenerationSettings } from '@shared/generation';
import { IPC_CHANNELS } from '@shared/ipc';

export interface GenerationIpcDeps {
  setSessionGeneration(sessionId: string, generation: GenerationSettings): Promise<ChatSessionSummary | null>;
}

export function registerGenerationIpc(ipc: Pick<IpcMain, 'handle'>, deps: GenerationIpcDeps): void {
  // Null, as for a session that is gone, rather than storing part of a set the renderer never meant.
  ipc.handle(IPC_CHANNELS.chatSetSessionGeneration, (_event, sessionId: unknown, generation: unknown) => {
    const settings = parseGenerationInput(generation);
    return typeof sessionId === 'string' && settings ? deps.setSessionGeneration(sessionId, settings) : null;
  });
}
