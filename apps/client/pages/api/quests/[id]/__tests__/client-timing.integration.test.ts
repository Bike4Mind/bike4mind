// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

/** Drives the real handler through the middleware chain `baseApi` assembles. */

const { mockQuestFindById, mockQuestUpdate, mockSetClientFirstTokenTime, mockSessionFindById, currentUser } =
  vi.hoisted(() => ({
    mockQuestFindById: vi.fn(),
    mockQuestUpdate: vi.fn(),
    mockSetClientFirstTokenTime: vi.fn(),
    mockSessionFindById: vi.fn(),
    currentUser: { value: { id: 'owner' } },
  }));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    questRepository: {
      ...(actual.questRepository as object),
      findById: (...a: unknown[]) => mockQuestFindById(...a),
      update: (...a: unknown[]) => mockQuestUpdate(...a),
      setClientFirstTokenTime: (...a: unknown[]) => mockSetClientFirstTokenTime(...a),
    },
    sessionRepository: {
      ...(actual.sessionRepository as object),
      findById: (...a: unknown[]) => mockSessionFindById(...a),
    },
  };
});

vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      req.user = { ...currentUser.value, _id: currentUser.value.id, isBanned: false, disputePending: false };
      next();
    },
  };
});

import handler from '../client-timing';

function fire(body: unknown = { clientFirstTokenTime: 250 }) {
  const { req, res } = createMocks(
    { method: 'POST', url: '/api/quests/quest-1/client-timing', query: { id: 'quest-1' }, body },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('POST /api/quests/[id]/client-timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.value = { id: 'owner' };
    mockQuestFindById.mockResolvedValue({
      id: 'quest-1',
      sessionId: 'sess-1',
      promptMeta: { performance: { firstChunkTime: 10 } },
    });
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'sharee' }] });
    mockSetClientFirstTokenTime.mockResolvedValue(true);
  });

  it('writes only the client timing, never the promptMeta it read', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true, clientFirstTokenTime: 250, questId: 'quest-1' });
    expect(mockSetClientFirstTokenTime).toHaveBeenCalledWith('quest-1', 250);
    expect(mockQuestUpdate).not.toHaveBeenCalled();
  });

  it('accepts a share holder', async () => {
    currentUser.value = { id: 'sharee' };
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockSetClientFirstTokenTime).toHaveBeenCalled();
  });

  it('404s a user with no relationship to the session, without writing', async () => {
    currentUser.value = { id: 'stranger' };
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockSetClientFirstTokenTime).not.toHaveBeenCalled();
  });

  it('404s when the quest is gone by the time of the write', async () => {
    mockSetClientFirstTokenTime.mockResolvedValue(false);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('rejects a non-positive timing', async () => {
    const { req, res } = fire({ clientFirstTokenTime: 0 });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(422);
    expect(mockSetClientFirstTokenTime).not.toHaveBeenCalled();
  });
});
