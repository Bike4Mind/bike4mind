import type { IpcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import { rolePolicySchema, taskActionSchema, type TaskDecisionAnswer } from '@shared/orchestration';
import type { ChatService } from './ChatService';

export function registerOrchestrationIpc(
  ipc: Pick<IpcMain, 'handle'>,
  service: Pick<
    ChatService,
    'getRolePolicy' | 'setRolePolicy' | 'actOnTask' | 'listTaskDecisions' | 'answerTaskDecision'
  >
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
  ipc.handle(IPC_CHANNELS.chatListTaskDecisions, () => service.listTaskDecisions());
  ipc.handle(IPC_CHANNELS.chatAnswerTaskDecision, (_event, sessionId: unknown, decisionId: unknown, answer: unknown) =>
    service.answerTaskDecision(
      z.uuid().parse(sessionId),
      z.string().min(1).max(100).parse(decisionId),
      taskDecisionAnswerSchema.parse(answer)
    )
  );
}

// Answers are held to the card's own shapes again in main (sanitizeAnswers); this only bounds them.
const taskDecisionAnswerSchema: z.ZodType<TaskDecisionAnswer> = z.union([
  z.strictObject({ status: z.literal('skipped') }),
  z.strictObject({
    status: z.literal('answered'),
    answers: z
      .array(z.strictObject({ selected: z.array(z.string().max(200)).max(4), other: z.string().max(5000).optional() }))
      .max(4),
  }),
]);
