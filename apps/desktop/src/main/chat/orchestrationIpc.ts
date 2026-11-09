import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import { rolePolicySchema, taskActionSchema } from '@shared/orchestration';
import type { ChatService } from './ChatService';

export function registerOrchestrationIpc(
  ipc: Pick<IpcMain, 'handle'>,
  service: Pick<ChatService, 'getRolePolicy' | 'setRolePolicy' | 'actOnTask'>
): void {
  ipc.handle(IPC_CHANNELS.chatGetRolePolicy, () => service.getRolePolicy());
  ipc.handle(IPC_CHANNELS.chatSetRolePolicy, (_event, value: unknown) =>
    service.setRolePolicy(rolePolicySchema.parse(value))
  );
  ipc.handle(IPC_CHANNELS.chatTaskAction, (_event, sessionId: unknown, value: unknown) => {
    const action = taskActionSchema.parse(value);
    if (action.kind === 'report') throw new Error('Only the worker reports its own evidence.');
    return service.actOnTask(null, z.uuid().parse(sessionId), action);
  });
}
