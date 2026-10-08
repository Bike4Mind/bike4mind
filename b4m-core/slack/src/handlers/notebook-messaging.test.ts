import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { CommandHandler } from '../CommandHandler';
import { sendMessageToNotebookAndGetResponse } from './notebook-messaging';

const user = { id: 'user-1' };
const ability = { sentinel: 'ability' };
const mockGetOrCreateSession = vi.fn();
const mockAddMessageToSession = vi.fn();

vi.mock('../di/registry', () => ({
  getSlackDb: () => ({
    User: { findById: vi.fn().mockResolvedValue(user) },
    Quest: {
      findById: () => ({ select: () => ({ lean: vi.fn().mockResolvedValue(null) }) }),
      findByIdAndUpdate: vi.fn(),
    },
    defineAbilitiesFor: () => ability,
  }),
  getSlackDeps: () => ({
    sessionManager: { getOrCreateSession: mockGetOrCreateSession, addMessageToSession: mockAddMessageToSession },
  }),
}));

const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
const trigger = vi.fn();
const commandHandler = { triggerAIResponseWithContext: trigger } as unknown as CommandHandler;

const send = (fabFileIds: string[], fileMetadata: Array<{ fabFileId: string; mimeType: string }>) =>
  sendMessageToNotebookAndGetResponse(
    'sess-1',
    'user-1',
    'hi',
    'system',
    logger,
    commandHandler,
    undefined,
    fabFileIds,
    undefined,
    false,
    [],
    fileMetadata
  );

describe('sendMessageToNotebookAndGetResponse file persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddMessageToSession.mockResolvedValue({ id: 'quest-1' });
    trigger.mockResolvedValue('reply');
  });

  it('persists documents to the notebook with the caller ability, but not images', async () => {
    await send(
      ['pdf-1', 'png-1'],
      [
        { fabFileId: 'pdf-1', mimeType: 'application/pdf' },
        { fabFileId: 'png-1', mimeType: 'image/png' },
      ]
    );

    expect(mockGetOrCreateSession).toHaveBeenCalledTimes(1);
    const params = mockGetOrCreateSession.mock.calls[0][0];
    expect(params).toEqual(expect.objectContaining({ sessionId: 'sess-1', fabFileIds: ['pdf-1'], user }));
    // Same object: the no-ability fallback is owner-only and would 404 a routed shared notebook.
    expect(params.ability).toBe(ability);
    // This turn still sees every file.
    expect(trigger.mock.calls[0][4]).toEqual(['pdf-1', 'png-1']);
  });

  it('skips the persist for image-only or file-less messages', async () => {
    await send(['png-1'], [{ fabFileId: 'png-1', mimeType: 'image/png' }]);
    await send([], []);

    expect(mockGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('logs a failed persist and still replies', async () => {
    mockGetOrCreateSession.mockRejectedValueOnce(new Error('Session not found'));

    const result = await send(['pdf-1'], [{ fabFileId: 'pdf-1', mimeType: 'application/pdf' }]);

    expect(logger.warn).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalled();
    expect(result.text).toBe('reply');
  });
});
