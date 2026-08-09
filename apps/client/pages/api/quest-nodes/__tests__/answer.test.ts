import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Handler-layer coverage for the two things this route decides: WHICH execution
 * a reply is read for, and what happens when the reply is too big to ship.
 *
 * The which matters because the client keys its cache (staleTime: Infinity) on
 * the execution the poll reported. Re-resolving from the node document instead
 * would, on the retry path, file the new run's reply under the old run's key
 * and keep it there.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  answerArgs: undefined as undefined | [string, string],
  storedAnswer: 'the reply' as string | null,
  nodeExecutionId: 'exec-2' as string | null,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    findAnswerByExecutionId: (id: string, userId: string) => {
      mockRefs.answerArgs = [id, userId];
      return Promise.resolve(mockRefs.storedAnswer);
    },
  },
}));

vi.mock('@server/questmaster/v5/questGraphAccess', () => ({
  requireOwnedNode: () =>
    Promise.resolve({
      node: { id: 'node-1', execution: { agentExecutionId: mockRefs.nodeExecutionId } },
    }),
}));

import '@pages/api/quest-nodes/[id]/answer';

async function get(query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query, url: '/api/quest-nodes/node-1/answer' });
  (req as any).user = { id: 'user-1' };
  await mockRefs.getHandler!(req, res);
  return res._getJSONData();
}

describe('GET /api/quest-nodes/[id]/answer', () => {
  beforeEach(() => {
    mockRefs.answerArgs = undefined;
    mockRefs.storedAnswer = 'the reply';
    mockRefs.nodeExecutionId = 'exec-2';
  });

  // The retry race: the poll still says exec-1, the document already says
  // exec-2. Answering for exec-2 here is what poisons the exec-1 cache entry.
  it('answers for the execution the client asked about, not the node current one', async () => {
    const body = await get({ id: 'node-1', executionId: 'exec-1' });

    expect(mockRefs.answerArgs?.[0]).toBe('exec-1');
    expect(body.executionId).toBe('exec-1');
    expect(body.answer).toBe('the reply');
  });

  it('falls back to the node current execution when the client names none', async () => {
    const body = await get({ id: 'node-1' });

    expect(mockRefs.answerArgs?.[0]).toBe('exec-2');
    expect(body.executionId).toBe('exec-2');
  });

  // The execution id is client-supplied, so the caller scope is the only thing
  // stopping it from naming someone else's run.
  it('scopes the lookup to the calling user', async () => {
    await get({ id: 'node-1', executionId: 'exec-1' });

    expect(mockRefs.answerArgs?.[1]).toBe('user-1');
  });

  it('reports no reply when the node never ran and none was asked for', async () => {
    mockRefs.nodeExecutionId = null;

    const body = await get({ id: 'node-1' });

    expect(mockRefs.answerArgs).toBeUndefined();
    expect(body).toMatchObject({ executionId: null, answer: null, unavailableReason: null });
  });

  // Withheld whole, never truncated: slicing a reply mid-<artifact> is the bug
  // this endpoint was built to remove.
  it('withholds an oversized reply with a reason instead of failing opaquely', async () => {
    mockRefs.storedAnswer = 'x'.repeat(4_000_001);

    const body = await get({ id: 'node-1', executionId: 'exec-1' });

    expect(body.answer).toBeNull();
    expect(body.unavailableReason).toBe('too_large');
  });

  it('ships a reply that sits under the limit', async () => {
    mockRefs.storedAnswer = 'x'.repeat(4_000_000);

    const body = await get({ id: 'node-1', executionId: 'exec-1' });

    expect(body.answer).toHaveLength(4_000_000);
    expect(body.unavailableReason).toBeNull();
  });
});
