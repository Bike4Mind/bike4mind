import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  quests: [] as Record<string, unknown>[],
  session: {} as Record<string, unknown>,
  update: vi.fn(),
  complete: vi.fn(),
  recordUsage: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: { ContextSummarize: { schema: { parse: (properties: unknown) => properties } } },
}));
vi.mock('@bike4mind/database', () => ({
  Quest: { find: vi.fn(() => ({ sort: async () => h.quests })) },
  Session: { findById: async () => h.session },
  sessionRepository: { update: h.update },
  userRepository: { findById: h.findUser },
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: 'test-model', modelInfo: {}, llm: { complete: h.complete } }),
  },
}));
vi.mock('@workers/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: h.recordUsage }));

import { handler } from './sessionContextSummarization';

const logger = { updateMetadata: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
const run = () =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { properties: { sessionId: 'session-1', verbatimWindowStartQuestId: '000000000000000000000003' } },
    logger
  );

describe('sessionContextSummarization stopped turns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findUser.mockResolvedValue({ id: 'user-1' });
    h.session = { id: 'session-1', userId: 'user-1', contextSummary: 'Existing context' };
    h.quests = [
      { id: '000000000000000000000001', prompt: 'partial ask', status: 'stopped', replies: ['partial answer'] },
      { id: '000000000000000000000002', prompt: 'cancelled ask', status: 'stopped', replies: [] },
    ];
    h.complete.mockImplementation(
      async (_model: string, _messages: unknown, _options: unknown, onChunk: (chunk: string[]) => Promise<void>) => {
        await onChunk(['Updated context']);
      }
    );
  });

  it('omits cancelled prompts from working memory and advances past them', async () => {
    await run();

    const messages = h.complete.mock.calls[0][1];
    expect(messages).toContainEqual({ role: 'user', content: 'Q: partial ask\nA: partial answer' });
    expect(JSON.stringify(messages)).not.toContain('cancelled ask');
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSummary: 'Updated context',
        contextSummaryUpToQuestId: '000000000000000000000002',
      })
    );
  });

  it('advances an all-cancelled window without replacing existing memory or charging a model call', async () => {
    h.quests = [h.quests[1]];
    await run();

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith({
      id: 'session-1',
      contextSummaryUpToQuestId: '000000000000000000000002',
    });
  });

  it.each([null, { id: 'user-1', riskScore: { reviewState: 'pending' } }, { id: 'user-1', isModerated: true }])(
    'skips the model and billing when the owner cannot use AI: %j',
    async user => {
      h.findUser.mockResolvedValue(user);
      await run();
      expect(h.findUser).toHaveBeenCalledWith('user-1');
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.recordUsage).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    }
  );

  it('does not run the model when the account lookup fails', async () => {
    h.findUser.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(run()).rejects.toThrow('database unavailable');
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });
});
