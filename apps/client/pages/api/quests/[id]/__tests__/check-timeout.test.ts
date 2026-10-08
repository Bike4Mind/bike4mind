import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/quests/[id]/check-timeout: recovers a genuinely stuck quest (see
 * questTimeoutRecovery's liveness docblock) and, on a settle it won, dispatches the
 * generation completion callback exactly once. Modeled on
 * user-api-keys/[id]/__tests__/callback-secret.test.ts's shallow baseApi mock (the
 * handler is captured and invoked directly); resolveQuestTimeoutRecovery,
 * dispatchQuestCallback and the db repositories are mocked so these exercise only the
 * route's own dispatch-on-applied-settle wiring, not the recovery/dispatch internals
 * (covered by questTimeoutRecovery's and dispatchQuestCallback's own unit tests).
 */

const mockRefs = vi.hoisted(() => ({
  handler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: () => chain,
    patch: () => chain,
    delete: () => chain,
    post: (fn: any) => {
      mockRefs.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const questRepository = vi.hoisted(() => ({
  findById: vi.fn(),
  settleIfUnfinished: vi.fn(),
}));
const sessionRepository = vi.hoisted(() => ({
  findById: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ questRepository, sessionRepository }));

const resolveQuestTimeoutRecovery = vi.hoisted(() => vi.fn());
vi.mock('@server/chatCompletion/questTimeoutRecovery', async () => {
  // Keep the real exports (notably STUCK_QUEST_RECOVERED_LOG) so the assertion pins the message
  // every settle site must share; only the decision function is stubbed.
  const actual = await vi.importActual<typeof import('@server/chatCompletion/questTimeoutRecovery')>(
    '@server/chatCompletion/questTimeoutRecovery'
  );
  return { ...actual, resolveQuestTimeoutRecovery };
});

const dispatchQuestCallback = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/generationCallback/dispatchQuestCallback', () => ({ dispatchQuestCallback }));

import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { STUCK_QUEST_RECOVERED_LOG } from '@server/chatCompletion/questTimeoutRecovery';
import '@pages/api/quests/[id]/check-timeout';

const quest = (overrides: Record<string, unknown> = {}) => ({
  id: 'quest-1',
  sessionId: 'session-1',
  status: 'running',
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  userId: 'user-1',
  users: [],
  ...overrides,
});

function post(id: string | undefined) {
  const { req, res } = createMocks({ method: 'POST', query: id === undefined ? {} : { id } });
  (req as any).user = { id: 'user-1' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/quests/[id]/check-timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    questRepository.settleIfUnfinished.mockResolvedValue(true);
    dispatchQuestCallback.mockResolvedValue(undefined);
  });

  it('rejects a missing quest id with a 400 BadRequestError', async () => {
    const { req, res } = post(undefined);

    const error = await mockRefs.handler!(req, res).catch(e => e);

    expect(error).toBeInstanceOf(BadRequestError);
    expect(dispatchQuestCallback).not.toHaveBeenCalled();
  });

  it('dispatches the callback once when an applied recovery settles the quest, and returns the re-read quest', async () => {
    const staleQuest = quest();
    const updatedQuest = quest({ status: 'done' });
    questRepository.findById.mockResolvedValueOnce(staleQuest).mockResolvedValueOnce(updatedQuest);
    sessionRepository.findById.mockResolvedValue(session());
    resolveQuestTimeoutRecovery.mockReturnValue({ status: 'done', finishReason: 'run_timed_out' });
    questRepository.settleIfUnfinished.mockResolvedValue(true);
    const { req, res } = post('quest-1');

    await mockRefs.handler!(req, res);

    expect(questRepository.settleIfUnfinished).toHaveBeenCalledWith('quest-1', {
      status: 'done',
      finishReason: 'run_timed_out',
    });
    expect(dispatchQuestCallback).toHaveBeenCalledTimes(1);
    expect(dispatchQuestCallback).toHaveBeenCalledWith('quest-1', req.logger);
    // The recovery that actually settles a watched quest must reach the LiveOps Slack channel;
    // without this line the sweep never gets the chance (the quest is no longer running).
    expect(req.logger.error).toHaveBeenCalledTimes(1);
    expect(req.logger.error).toHaveBeenCalledWith(STUCK_QUEST_RECOVERED_LOG, {
      questId: 'quest-1',
      via: 'check-timeout',
    });
    expect(res._getJSONData()).toEqual(updatedQuest);
  });

  it('does not settle or dispatch when the quest is not stuck (recovery is null)', async () => {
    const liveQuest = quest();
    questRepository.findById.mockResolvedValue(liveQuest);
    sessionRepository.findById.mockResolvedValue(session());
    resolveQuestTimeoutRecovery.mockReturnValue(null);
    const { req, res } = post('quest-1');

    await mockRefs.handler!(req, res);

    expect(questRepository.settleIfUnfinished).not.toHaveBeenCalled();
    expect(dispatchQuestCallback).not.toHaveBeenCalled();
    // A live quest is not a stall; no recovery, no alert.
    expect(req.logger.error).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual(liveQuest);
  });

  it('does not dispatch when the settle race is lost, but still returns the re-read quest', async () => {
    const staleQuest = quest();
    const wonByAnotherSite = quest({ status: 'done' });
    questRepository.findById.mockResolvedValueOnce(staleQuest).mockResolvedValueOnce(wonByAnotherSite);
    sessionRepository.findById.mockResolvedValue(session());
    resolveQuestTimeoutRecovery.mockReturnValue({ status: 'done', finishReason: 'run_timed_out' });
    questRepository.settleIfUnfinished.mockResolvedValue(false);
    const { req, res } = post('quest-1');

    await mockRefs.handler!(req, res);

    expect(dispatchQuestCallback).not.toHaveBeenCalled();
    // A lost race means another settle site won and logs for itself - logging here would double
    // every recovery.
    expect(req.logger.error).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual(wonByAnotherSite);
  });

  it('returns a 404 for a user with no access to the quest session, and never dispatches', async () => {
    questRepository.findById.mockResolvedValue(quest());
    sessionRepository.findById.mockResolvedValue(session({ userId: 'someone-else', users: [] }));
    const { req, res } = post('quest-1');

    const error = await mockRefs.handler!(req, res).catch(e => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(resolveQuestTimeoutRecovery).not.toHaveBeenCalled();
    expect(dispatchQuestCallback).not.toHaveBeenCalled();
  });
});
