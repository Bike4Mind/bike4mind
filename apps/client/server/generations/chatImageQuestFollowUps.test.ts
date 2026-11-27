import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import type { Request } from 'express';

const h = vi.hoisted(() => ({
  sendToClient: vi.fn(),
  publishSummarize: vi.fn(),
  publishAutoName: vi.fn(),
  shouldSummarizeSession: vi.fn(),
  quests: { count: vi.fn() },
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  SessionEvents: { Summarize: { publish: h.publishSummarize }, AutoName: { publish: h.publishAutoName } },
}));
vi.mock('@bike4mind/services/llm', () => ({
  shouldSummarizeSession: h.shouldSummarizeSession,
}));
vi.mock('@bike4mind/database', () => ({ questRepository: h.quests }));

import {
  broadcastChatImageQuest,
  maybeSummarizeAfterChatImage,
  nameNotebookAfterChatImage,
} from './chatImageQuestFollowUps';

const logger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) as unknown as Request['logger'];
const QUEST = {
  id: 'quest-1',
  sessionId: 'sess-1',
  type: 'message',
  status: 'done',
  replies: [],
  images: [],
  generationJobs: [{ id: 'job-1', kind: 'image' }],
  prompt: 'a lighthouse',
  promptMeta: { model: { name: 'gpt-image-1.5' } },
} as unknown as IChatHistoryItemDocument;
const SESSION = { id: 'sess-1' } as ISessionDocument;

describe('broadcastChatImageQuest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the settled turn, job refs included, to the requester connections as a final frame', async () => {
    await broadcastChatImageQuest('user-1', QUEST, logger());

    expect(h.sendToClient).toHaveBeenCalledWith('user-1', 'wss://test', {
      action: 'streamed_chat_completion',
      quest: expect.objectContaining({
        id: 'quest-1',
        sessionId: 'sess-1',
        status: 'done',
        generationJobs: [{ id: 'job-1', kind: 'image' }],
      }),
      statusMessage: null,
    });
    const [, , frame] = h.sendToClient.mock.calls[0];
    expect(frame.quest).not.toHaveProperty('promptMeta');
  });

  it('logs and swallows a send failure, so the send still answers', async () => {
    h.sendToClient.mockRejectedValue(new Error('gone'));
    const log = logger();
    await expect(broadcastChatImageQuest('user-1', QUEST, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('maybeSummarizeAfterChatImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes the summary event, paid by the requester, when the session is due', async () => {
    h.shouldSummarizeSession.mockResolvedValue([true, 'earlyMilestone']);

    await maybeSummarizeAfterChatImage(SESSION, 'user-1', logger());

    expect(h.shouldSummarizeSession).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ db: { quests: h.quests } })
    );
    expect(h.publishSummarize).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      callTagging: true,
      trigger: 'earlyMilestone',
      payerId: 'user-1',
    });
  });

  it('publishes nothing when the session is not due', async () => {
    h.shouldSummarizeSession.mockResolvedValue([false, 'throttling']);
    await maybeSummarizeAfterChatImage(SESSION, 'user-1', logger());
    expect(h.publishSummarize).not.toHaveBeenCalled();
  });

  it('logs and swallows a failure, so the send still answers', async () => {
    h.shouldSummarizeSession.mockRejectedValue(new Error('db down'));
    const log = logger();
    await expect(maybeSummarizeAfterChatImage(SESSION, 'user-1', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('nameNotebookAfterChatImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes the naming event for the session and the requester, as the legacy generation did', async () => {
    await nameNotebookAfterChatImage('sess-1', 'user-1', logger());
    expect(h.publishAutoName).toHaveBeenCalledWith({ sessionId: 'sess-1', userId: 'user-1' });
  });

  it('logs and swallows a dispatch failure, so the send still answers', async () => {
    h.publishAutoName.mockRejectedValue(new Error('eventbridge down'));
    const log = logger();
    await expect(nameNotebookAfterChatImage('sess-1', 'user-1', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
