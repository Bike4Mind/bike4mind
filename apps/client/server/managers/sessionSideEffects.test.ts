import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock state must be created via vi.hoisted so it exists when the hoisted vi.mock
// factories below run (they are lifted above normal top-level declarations).
const { sendToClient, createActivity, logEvent, summarizePublish, contextSummarizePublish } = vi.hoisted(() => ({
  sendToClient: vi.fn().mockResolvedValue(undefined),
  createActivity: vi.fn().mockResolvedValue({ id: 'activity-1' }),
  logEvent: vi.fn().mockResolvedValue(undefined),
  summarizePublish: vi.fn().mockResolvedValue(undefined),
  contextSummarizePublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/utils', () => ({
  // Regular function (not arrow) so it is usable with `new`.
  ClientMessageSender: vi.fn(function (this: Record<string, unknown>) {
    this.sendToClient = sendToClient;
  }),
}));

vi.mock('@bike4mind/database', () => ({
  Connection: { __model: 'Connection' },
  activityRepository: { createActivity },
}));

vi.mock('@bike4mind/common', () => ({
  SessionEvents: { CREATE_SESSION: 'session.create' },
  ProjectEvents: { ADD_SESSION: 'project.addSession' },
  // Faithful stub of the real helper: shallow copy minus server-owned fields.
  redactSessionForClient: (s: Record<string, unknown> | null | undefined) => {
    if (s == null) return s;
    const copy = { ...s };
    delete copy.systemPromptText;
    return copy;
  },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { log: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

vi.mock('@client/config/activities', () => ({
  ActivityType: { NOTEBOOK_ADDED_TO_PROJECT: 'notebook.addedToProject' },
}));

vi.mock('sst', () => ({
  Resource: { websocket: { managementEndpoint: 'wss://mgmt' } },
}));

vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    Summarize: { publish: summarizePublish },
    ContextSummarize: { publish: contextSummarizePublish },
  },
}));

import {
  notifySessionCreated,
  logSessionCreatedEvent,
  logProjectSessionAddedEvent,
  recordNotebookAddedToProjectActivity,
  publishSummarizeSession,
  publishContextSummarizeSession,
} from './sessionSideEffects';
import { ClientMessageSender } from '@bike4mind/utils';
import type { ISessionDocument } from '@bike4mind/common';
import type { Ability } from '@server/auth/ability';
import type { Logger } from '@bike4mind/observability';

// Typed mock factories: `Partial<ISessionDocument>` gives field-name checking, so a
// renamed/removed schema field surfaces as a compile error instead of silently passing.
const mockSession = (s: Partial<ISessionDocument>): ISessionDocument => s as ISessionDocument;
const mockAbility = (): Ability => ({ marker: 'ability' }) as unknown as Ability;

// Minimal logger stub matching the Logger shape the helpers pass through.
const logger = { log: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('sessionSideEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('notifySessionCreated', () => {
    it('sends a session.created WebSocket message with concrete global flags', async () => {
      const session = mockSession({ id: 's1', name: 'Notebook', isGlobalRead: true });

      await notifySessionCreated(session, 'user-1', logger);

      expect(ClientMessageSender).toHaveBeenCalledTimes(1);
      expect(sendToClient).toHaveBeenCalledTimes(1);
      const [userId, endpoint, payload] = sendToClient.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(endpoint).toBe('wss://mgmt');
      expect(payload).toMatchObject({
        action: 'session.created',
        id: 's1',
        name: 'Notebook',
        isGlobalRead: true,
        // absent on the source session -> defaulted to false
        isGlobalWrite: false,
      });
    });

    it('defaults both global flags to false when absent', async () => {
      await notifySessionCreated(mockSession({ id: 's2', name: 'N' }), 'user-2', logger);
      const payload = sendToClient.mock.calls[0][2];
      expect(payload.isGlobalRead).toBe(false);
      expect(payload.isGlobalWrite).toBe(false);
    });
  });

  describe('logSessionCreatedEvent', () => {
    it('logs CREATE_SESSION with session metadata and forwards ability', async () => {
      const ability = mockAbility();
      await logSessionCreatedEvent(
        'user-1',
        mockSession({ id: 's1', name: 'NB', knowledgeIds: ['k1'], agentIds: ['a1'] }),
        ability
      );

      expect(logEvent).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          type: 'session.create',
          metadata: { sessionId: 's1', sessionName: 'NB', knowledgeIds: ['k1'], agentIds: ['a1'] },
        },
        { ability }
      );
    });

    it('defaults knowledgeIds and agentIds to empty arrays when absent', async () => {
      await logSessionCreatedEvent('user-1', mockSession({ id: 's1', name: 'NB' }));
      expect(logEvent.mock.calls[0][0].metadata).toMatchObject({ knowledgeIds: [], agentIds: [] });
    });
  });

  describe('logProjectSessionAddedEvent', () => {
    it('logs ADD_SESSION with project + content metadata', async () => {
      const ability = mockAbility();
      await logProjectSessionAddedEvent('user-1', 'proj-1', 'My Project', 'sess-1', ability);

      expect(logEvent).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          type: 'project.addSession',
          metadata: { projectId: 'proj-1', projectName: 'My Project', contentId: 'sess-1', contentType: 'session' },
        },
        { ability }
      );
    });
  });

  describe('recordNotebookAddedToProjectActivity', () => {
    it('creates the NOTEBOOK_ADDED_TO_PROJECT activity linking project and user', async () => {
      await recordNotebookAddedToProjectActivity('proj-1', 'user-1');
      expect(createActivity).toHaveBeenCalledWith(
        'notebook.addedToProject',
        { type: 'Project', id: 'proj-1' },
        { type: 'User', id: 'user-1' }
      );
    });
  });

  describe('publishSummarizeSession', () => {
    it('publishes a Summarize event with callTagging and trigger', async () => {
      await publishSummarizeSession('sess-1', 'manual');
      expect(summarizePublish).toHaveBeenCalledWith({ sessionId: 'sess-1', callTagging: true, trigger: 'manual' });
    });
  });

  describe('publishContextSummarizeSession', () => {
    it('publishes a ContextSummarize event with the verbatim window start', async () => {
      await publishContextSummarizeSession('sess-1', 'quest-9');
      expect(contextSummarizePublish).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        verbatimWindowStartQuestId: 'quest-9',
      });
    });
  });
});
