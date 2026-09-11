import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({ createFeedbackOnServer: vi.fn() }));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  createFeedbackOnServer: h.createFeedbackOnServer,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';
import { findLatestQuestId, handleFeedbackCommand, FEEDBACK_COMMAND_USAGE } from './FeedbackCommand';

const SESSION = { id: 'session-1' } as ISessionDocument;

const seedQuests = (queryClient: QueryClient, pages: Array<{ data: unknown[] }>) =>
  queryClient.setQueryData(['quests', 'session', SESSION.id], { pages, pageParams: [] });

const run = (queryClient: QueryClient, params: string, addMessageToSession = vi.fn()) =>
  handleFeedbackCommand({
    params,
    userId: 'user-1',
    username: 'ada',
    userEmail: 'ada@example.com',
    currentSession: SESSION,
    queryClient,
    addMessageToSession,
  });

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
  h.createFeedbackOnServer.mockReset();
  h.createFeedbackOnServer.mockResolvedValue({ id: 'fb1', contentStored: true });
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.info).mockReset();
});

describe('findLatestQuestId', () => {
  it('returns undefined when the session has no cached quests', () => {
    expect(findLatestQuestId(queryClient, SESSION.id)).toBeUndefined();
  });

  it('picks the newest quest across pages, ignoring optimistic bubbles', () => {
    seedQuests(queryClient, [
      {
        data: [
          { id: `optimistic-quest-${SESSION.id}`, createdAt: '2026-01-03T00:00:00Z' },
          { id: 'quest-newest', createdAt: '2026-01-02T00:00:00Z' },
        ],
      },
      { data: [{ id: 'quest-older', createdAt: '2026-01-01T00:00:00Z' }] },
    ]);

    expect(findLatestQuestId(queryClient, SESSION.id)).toBe('quest-newest');
  });
});

describe('handleFeedbackCommand', () => {
  it('sends the session as the subject with the newest quest as context', async () => {
    seedQuests(queryClient, [{ data: [{ id: 'quest-newest', createdAt: '2026-01-02T00:00:00Z' }] }]);

    await run(queryClient, '  retrieval keeps missing my specs  ');

    expect(h.createFeedbackOnServer).toHaveBeenCalledTimes(1);
    expect(h.createFeedbackOnServer.mock.calls[0][0]).toMatchObject({
      content: 'retrieval keeps missing my specs',
      sessionId: SESSION.id,
      contextQuestId: 'quest-newest',
    });
    // The subject is the session, so no questId claim is sent - that would make the server
    // record this as a report about one turn.
    expect(h.createFeedbackOnServer.mock.calls[0][0]).not.toHaveProperty('questId');
  });

  it('omits contextQuestId when nothing has been asked yet', async () => {
    await run(queryClient, 'first impressions are good');

    expect(h.createFeedbackOnServer.mock.calls[0][0].contextQuestId).toBeUndefined();
  });

  it('explains itself and sends nothing when given no text', async () => {
    const addMessageToSession = vi.fn();
    await run(queryClient, '   ', addMessageToSession);

    expect(h.createFeedbackOnServer).not.toHaveBeenCalled();
    expect(addMessageToSession.mock.calls[0][0].reply).toBe(FEEDBACK_COMMAND_USAGE);
  });

  it('warns rather than thanks when the team was not notified', async () => {
    h.createFeedbackOnServer.mockResolvedValue({ id: 'fb1', contentStored: true, delivery: { delivered: false } });
    const addMessageToSession = vi.fn();

    await run(queryClient, 'something is off', addMessageToSession);

    expect(toast.warning).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(addMessageToSession.mock.calls[0][0].reply).toContain('could not notify the team');
  });

  it('warns when the report saved but its text did not', async () => {
    h.createFeedbackOnServer.mockResolvedValue({ id: 'fb1', contentStored: false });

    await run(queryClient, 'something is off');

    expect(toast.warning).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a failed submission in-thread instead of throwing', async () => {
    h.createFeedbackOnServer.mockRejectedValue(new Error('network down'));
    const addMessageToSession = vi.fn();

    await expect(run(queryClient, 'something is off', addMessageToSession)).resolves.toBeUndefined();

    expect(toast.error).toHaveBeenCalled();
    expect(addMessageToSession.mock.calls[0][0].reply).toContain('Could not submit your feedback');
  });
});
