import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The endpoint must authorize against the fetched DOCUMENT, not the
 * FeedbackModel class: a by-class CASL check does not evaluate the { userId }
 * ownership condition, so ownership is only enforced against the instance. These
 * tests prove `can` is called with the instance and that a denied caller never
 * reaches the write.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const feedbackDoc = { id: 'fb1', userId: 'owner1', contentStored: false };
const model = vi.hoisted(() => ({
  findById: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));
const feedbackText = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({}),
  updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('@bike4mind/database', () => ({ FeedbackModel: model, FeedbackTextModel: feedbackText }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/feedback/[id]/update';

function mocks(can: (action: string, subject: unknown) => boolean) {
  const { req, res } = createMocks({
    method: 'PUT',
    query: { id: 'fb1' },
    body: { userId: 'someone', content: 'edited', username: 'x', status: 'open' },
  });
  (req as any).user = { id: 'attacker', isAdmin: false };
  (req as any).ability = { can: vi.fn(can) };
  return { req, res };
}

describe('PUT /api/feedback/[id] - instance-level authorization', () => {
  beforeEach(() => {
    model.findById.mockResolvedValue(feedbackDoc);
    const updatedFeedbackDoc = { ...feedbackDoc, content: 'edited' };
    // findOneAndUpdate returns a hydrated Mongoose document in production; the route calls
    // .toJSON() on it before redacting, so the mock needs that method too.
    model.findOneAndUpdate.mockResolvedValue({ ...updatedFeedbackDoc, toJSON: () => updatedFeedbackDoc });
    model.findOneAndUpdate.mockClear();
  });

  it('authorizes against the fetched document, not the model class', async () => {
    const { req, res } = mocks(() => true);
    await mockRefs.putHandler!(req, res);

    // The security-critical assertion: the ability check receives the instance.
    expect((req as any).ability.can).toHaveBeenCalledWith('update', feedbackDoc);
    expect((req as any).ability.can).not.toHaveBeenCalledWith('update', model);
  });

  it('rejects a non-owner (can -> false) without writing', async () => {
    const { req, res } = mocks(() => false);
    // A denied caller gets the same "not found" as a missing id (existence-hiding).
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(/not found/i);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('lets an authorized caller (owner/admin) update', async () => {
    const { req, res } = mocks(() => true);
    await mockRefs.putHandler!(req, res);
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('redacts functionCalls[].returnValue in the response, the same as GET /api/feedback', async () => {
    const promptMeta = {
      functionCalls: [
        { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
      ],
    };
    const updatedFeedbackDoc = { ...feedbackDoc, content: 'edited', promptMeta };
    model.findOneAndUpdate.mockResolvedValue({ ...updatedFeedbackDoc, toJSON: () => updatedFeedbackDoc });

    const { req, res } = mocks(() => true);
    await mockRefs.putHandler!(req, res);

    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body).toContain('web_search');
  });
});
