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

const feedbackDoc = { id: 'fb1', userId: 'owner1' };
const model = vi.hoisted(() => ({
  findById: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ FeedbackModel: model }));
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
    model.findOneAndUpdate.mockResolvedValue({ ...feedbackDoc, content: 'edited' });
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
});
