import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ChatService } from './ChatService';
import type { LocalHistory } from './LocalHistory';

const historySettingSchema = z.tuple([z.string().min(1), z.boolean()]);
const historyQuerySchema = z.string();

export function registerHistoryIpc(
  ipc: Pick<IpcMain, 'handle'>,
  service: Pick<ChatService, 'setSessionHistory' | 'searchHistory'>,
  history: Pick<LocalHistory, 'clear' | 'state'> | undefined
): void {
  const availableHistory = () => {
    if (!history) throw new Error('Local history is unavailable. Restart the app and try again.');
    return history;
  };
  ipc.handle(IPC_CHANNELS.chatSetSessionHistory, (_event, sessionId: unknown, enabled: unknown) => {
    const [id, setting] = historySettingSchema.parse([sessionId, enabled]);
    return service.setSessionHistory(id, setting);
  });
  ipc.handle(IPC_CHANNELS.chatSearchHistory, (_event, query: unknown) =>
    service.searchHistory(historyQuerySchema.parse(query))
  );
  ipc.handle(IPC_CHANNELS.chatClearHistory, () => availableHistory().clear());
  ipc.handle(IPC_CHANNELS.chatHistoryState, () => availableHistory().state());
}
