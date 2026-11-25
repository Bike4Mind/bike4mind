import { z } from 'zod';
import type {
  BackgroundProcessInfo,
  ChatApprovalAnswer,
  ChatModelCatalog,
  ChatQueueEvent,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  CreateCodeSessionRequest,
  CreateCodeSessionResult,
  ProjectInspection,
  SendMessageRequest,
  SendMessageResult,
} from '../chat';
import type { PendingTaskDecision, TaskDecisionAnswer } from '../orchestration';
import type { NewSessionDefaults } from '../sessionDefaults';

/*
 * The chat types are hand-written TypeScript that the whole app shares (shared/chat.ts and its
 * neighbours), and they pull in types from @bike4mind/common. Re-modelling them in Zod here would
 * fork a very large, fast-moving file, so these are guards: each checks only the fields the
 * protocol itself relies on and trusts the rest to be what the sending host's own types say.
 *
 * The additive-only rule in ./version covers them too: a host may add fields and union members to
 * these types within a major version, and a receiver must tolerate ones it does not know.
 */

type FieldKind = 'string' | 'number' | 'boolean' | 'array' | 'object';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const matchesKind = (value: unknown, kind: FieldKind): boolean => {
  switch (kind) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return typeof value === kind;
  }
};

/** A guard for a plain object that has each named field with the given kind. */
function structuralGuard<T>(fields: Readonly<Record<string, FieldKind>>) {
  return z.custom<T>(
    value => isRecord(value) && Object.entries(fields).every(([key, kind]) => matchesKind(value[key], kind))
  );
}

export const chatSessionPayloadSchema = structuralGuard<ChatSession>({ id: 'string' });
export const chatSessionSummaryPayloadSchema = structuralGuard<ChatSessionSummary>({ id: 'string' });
export const chatStreamEventPayloadSchema = structuralGuard<ChatStreamEvent>({ type: 'string', sessionId: 'string' });
export const chatSessionStatusEventPayloadSchema = structuralGuard<ChatSessionStatusEvent>({
  sessionId: 'string',
  status: 'string',
});
export const chatQueuedMessagePayloadSchema = structuralGuard<ChatQueuedMessage>({ id: 'string', sessionId: 'string' });
export const chatQueueEventPayloadSchema = structuralGuard<ChatQueueEvent>({ sessionId: 'string', queued: 'array' });
export const pendingTaskDecisionPayloadSchema = structuralGuard<PendingTaskDecision>({
  sessionId: 'string',
  decision: 'object',
});
export const chatApprovalAnswerPayloadSchema = structuralGuard<ChatApprovalAnswer>({ decision: 'string' });
export const taskDecisionAnswerPayloadSchema = structuralGuard<TaskDecisionAnswer>({ status: 'string' });
export const sendMessageRequestPayloadSchema = structuralGuard<SendMessageRequest>({
  sessionId: 'string',
  text: 'string',
});
export const sendMessageResultPayloadSchema = structuralGuard<SendMessageResult>({ ok: 'boolean' });
export const createCodeSessionRequestPayloadSchema = structuralGuard<CreateCodeSessionRequest>({});
export const createCodeSessionResultPayloadSchema = structuralGuard<CreateCodeSessionResult>({ ok: 'boolean' });
export const projectInspectionPayloadSchema = structuralGuard<ProjectInspection>({
  directory: 'string',
  isRepository: 'boolean',
  branches: 'array',
});
export const backgroundProcessPayloadSchema = structuralGuard<BackgroundProcessInfo>({
  id: 'string',
  sessionId: 'string',
  status: 'string',
});
export const chatModelCatalogPayloadSchema = structuralGuard<ChatModelCatalog>({ models: 'array' });
export const newSessionDefaultsPayloadSchema = structuralGuard<NewSessionDefaults>({
  model: 'string',
  approvalMode: 'string',
});
