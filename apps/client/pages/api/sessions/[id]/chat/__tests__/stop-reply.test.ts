import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/sessions/[id]/chat/stop-reply: a user stop is one of the generation
 * completion callback's settle sites (see dispatchQuestCallback's docblock), but only
 * when the stop actually won the race and settled the quest (stopReply returns
 * status 'stopped'). Modeled on quests/[id]/__tests__/check-timeout.test.ts's shallow
 * baseApi mock (the handler is captured and invoked directly); stopReply and
 * dispatchQuestCallback are mocked so this exercises only the route's own
 * dispatch-on-stopped wiring.
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

const stopReply = vi.hoisted(() => vi.fn());
vi.mock('@server/managers/sessionManager', () => ({ stopReply }));

const dispatchQuestCallback = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/generationCallback/dispatchQuestCallback', () => ({ dispatchQuestCallback }));

vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import '@pages/api/sessions/[id]/chat/stop-reply';

function post(sessionId: string) {
  const { req, res } = createMocks({ method: 'POST', query: { id: sessionId }, body: {} });
  (req as any).user = { id: 'user-1' };
  (req as any).ability = {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/sessions/[id]/chat/stop-reply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchQuestCallback.mockResolvedValue(undefined);
  });

  it("dispatches the completion callback with the settled quest's id when the stop wins the race", async () => {
    stopReply.mockResolvedValue({ status: 'stopped', id: 'quest-1' });
    const { req, res } = post('session-1');

    await mockRefs.handler!(req, res);

    expect(dispatchQuestCallback).toHaveBeenCalledTimes(1);
    expect(dispatchQuestCallback).toHaveBeenCalledWith('quest-1', req.logger);
    expect(res._getJSONData()).toMatchObject({ questId: 'quest-1' });
  });

  it('does not dispatch when the quest was already settled some other way (status other than stopped)', async () => {
    stopReply.mockResolvedValue({ status: 'done', id: 'quest-2' });
    const { req, res } = post('session-1');

    await mockRefs.handler!(req, res);

    expect(dispatchQuestCallback).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ questId: 'quest-2' });
  });

  it('does not dispatch when stopReply resolves no quest (null/undefined)', async () => {
    stopReply.mockResolvedValue(null);
    const { req, res } = post('session-1');

    await mockRefs.handler!(req, res);

    expect(dispatchQuestCallback).not.toHaveBeenCalled();
    expect(res._getJSONData().questId).toBeUndefined();
  });
});
