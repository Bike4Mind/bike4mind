import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findBrief: vi.fn(),
  markReady: vi.fn(),
  markFailed: vi.fn(),
  findUser: vi.fn(),
  listRuns: vi.fn(),
  pendingActions: vi.fn(),
  openQuestions: vi.fn(),
  readableSessions: vi.fn(),
  loadEmails: vi.fn(),
  loadDelegations: vi.fn(),
  markEmailsBriefed: vi.fn(),
  storedEmailIds: vi.fn(),
  markDelegationsBriefed: vi.fn(),
  findDueReminders: vi.fn(),
  markRemindersSurfaced: vi.fn(),
  getOperationsModel: vi.fn(),
  recordUsage: vi.fn(),
  payerCanFund: vi.fn(),
  accessDenied: vi.fn(),
  publishPush: vi.fn(),
}));

vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  BriefEvents: { Compose: { schema: { parse: (properties: unknown) => properties } } },
}));
vi.mock('@bike4mind/database', () => ({
  assistantBriefRepository: {
    findById: mocks.findBrief,
    markReady: mocks.markReady,
    markFailed: mocks.markFailed,
    removeEmailSourcedItems: vi.fn(),
    findDueReminders: mocks.findDueReminders,
    markRemindersSurfaced: mocks.markRemindersSurfaced,
  },
  userRepository: { findById: mocks.findUser },
  sessionRepository: { shareable: { findAllAccessibleByIds: mocks.readableSessions } },
  agentExecutionRepository: { findByUserIdPaginated: mocks.listRuns },
  questRepository: {
    findPendingActionsBySessionIds: mocks.pendingActions,
    findOpenQuestionsBySessionIds: mocks.openQuestions,
  },
  emailTriageItemRepository: { markBriefed: mocks.markEmailsBriefed, storedEmailIds: mocks.storedEmailIds },
  delegatedItemRepository: { markBriefed: mocks.markDelegationsBriefed },
}));
vi.mock('./loadPendingBriefEmails', () => ({ loadPendingBriefEmails: mocks.loadEmails }));
vi.mock('./loadDueBriefObligations', () => ({
  loadDueBriefObligations: vi.fn(async () => []),
  toBriefObligation: vi.fn(),
}));
vi.mock('./loadPendingBriefDelegations', () => ({ loadPendingBriefDelegations: mocks.loadDelegations }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mocks.getOperationsModel },
}));
vi.mock('@bike4mind/server-utils/utils/pushNotifications', () => ({
  publishPushNotification: mocks.publishPush,
  briefDeepLink: (id: string) => `b4m://brief/${id}`,
}));
vi.mock('@bike4mind/services/userService/accountState', () => ({ aiAccessDeniedMessage: mocks.accessDenied }));
vi.mock('@workers/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: mocks.recordUsage }));
vi.mock('@workers/events/sessionOperationalCreditGate', () => ({ payerCanFundSessionOperation: mocks.payerCanFund }));

import { handler } from './briefCompose';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
const run = () =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { properties: { briefId: 'b1', userId: 'u1' } },
    logger
  );

const reply = JSON.stringify({ headline: 'Busy day.', happened: ['Ran a sync.'], handled: [], decisions: [] });
const llm = {
  complete: vi.fn(
    async (
      _model: string,
      _messages: unknown,
      _options: unknown,
      onChunk: (chunks: (string | null)[], info?: unknown) => Promise<void>
    ) => {
      await onChunk([reply.slice(0, 10), undefined], undefined);
      await onChunk([reply.slice(10)], { outputTokens: 5 });
    }
  ),
};

describe('brief.compose handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findBrief.mockResolvedValue({
      userId: 'u1',
      status: 'composing',
      periodStart: new Date('2026-11-18T00:00:00Z'),
      periodEnd: new Date('2026-11-19T00:00:00Z'),
    });
    mocks.markReady.mockResolvedValue(true);
    mocks.findUser.mockResolvedValue({ id: 'u1' });
    mocks.accessDenied.mockReturnValue(null);
    mocks.payerCanFund.mockResolvedValue(true);
    mocks.listRuns.mockResolvedValue({
      items: [{ id: 'r1', sessionId: 's1', query: 'Sync', status: 'completed', completedAt: undefined }],
    });
    mocks.pendingActions.mockResolvedValue([
      { questId: 'q1', sessionId: 's1', ts: 7, tool: 'send_reply', params: { to: 'a' } },
      { questId: 'q2', sessionId: 's1', ts: 8, tool: 'archive' },
    ]);
    mocks.openQuestions.mockResolvedValue([]);
    mocks.readableSessions.mockImplementation(async (_user: unknown, ids: string[]) => ids.map(id => ({ id })));
    mocks.findDueReminders.mockResolvedValue([]);
    mocks.loadEmails.mockResolvedValue([
      {
        emailId: 'e1',
        kind: 'decision',
        summary: 'Answer the vendor.',
        draftReply: { to: 'v@example.com', subject: 'Re', body: 'Ok' },
      },
      { emailId: 'e2', kind: 'fyi', summary: 'Office closed.' },
    ]);
    mocks.loadDelegations.mockResolvedValue([
      { _id: { toString: () => 'g1' }, intent: 'Summarize', status: 'handled', result: 'Summary.' },
    ]);
    mocks.storedEmailIds.mockImplementation((_userId: string, ids: string[]) => Promise.resolve(ids));
    mocks.getOperationsModel.mockResolvedValue({ modelId: 'ops-model', llm, modelInfo: {} });
  });

  it('loads the activity, composes with the operations model and settles every carried record', async () => {
    await run();

    expect(mocks.loadDelegations).toHaveBeenCalledWith(
      'u1',
      new Date('2026-11-19T00:00:00Z'),
      expect.any(Date),
      undefined
    );
    expect(mocks.findDueReminders).toHaveBeenCalledWith('u1', expect.any(Date), expect.any(Number));
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'b1', operation: 'assistant_brief', completionInfo: { outputTokens: 5 } })
    );
    const content = mocks.markReady.mock.calls[0][1];
    expect(content.decisions.map((d: { id: string }) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(content.decisions[2]).toMatchObject({
      source: { kind: 'email', emailId: 'e1' },
      draftReply: { body: 'Ok' },
    });
    expect(content.handled[0]).toMatchObject({ text: 'Summary.', source: { kind: 'delegation', delegationId: 'g1' } });
    expect(mocks.markEmailsBriefed).toHaveBeenCalledWith('u1', ['e2', 'e1'], expect.any(Date));
    expect(mocks.markDelegationsBriefed).toHaveBeenCalledWith('u1', ['g1'], expect.any(Date));
    expect(mocks.publishPush).toHaveBeenCalledWith(expect.objectContaining({ briefId: 'b1' }), logger);
  });

  it('loads quests only from the run notebooks the user can read now', async () => {
    const user = { id: 'u1', groups: ['g'] };
    mocks.findUser.mockResolvedValue(user);
    mocks.listRuns.mockResolvedValue({
      items: [
        { id: 'r1', sessionId: 's1', query: 'Sync', status: 'completed', completedAt: undefined },
        { id: 'r2', sessionId: 's2', query: 'Send', status: 'completed', completedAt: undefined },
      ],
    });
    mocks.readableSessions.mockResolvedValue([{ id: 's1' }]);

    await run();

    expect(mocks.readableSessions).toHaveBeenCalledWith(user, ['s1', 's2']);
    expect(mocks.pendingActions).toHaveBeenCalledWith(['s1'], expect.any(Number), expect.any(Number));
    expect(mocks.openQuestions).toHaveBeenCalledWith(['s1'], expect.any(Date), expect.any(Number));
  });

  it.each([
    [
      'a missing user',
      () => mocks.findUser.mockResolvedValueOnce({ id: 'u1' }).mockResolvedValueOnce(null),
      'ai_access_held',
    ],
    ['held AI access', () => mocks.accessDenied.mockReturnValue('held'), 'ai_access_held'],
    ['an unfunded balance', () => mocks.payerCanFund.mockResolvedValue(false), 'insufficient_credits'],
  ])('fails the brief for %s', async (_label, arrange, reason) => {
    arrange();
    await run();
    expect(mocks.markFailed).toHaveBeenCalledWith('b1', reason);
    expect(mocks.getOperationsModel).not.toHaveBeenCalled();
  });
});
