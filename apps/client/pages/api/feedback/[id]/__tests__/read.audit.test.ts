import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/feedback/[id]/read records the staff read before serving the text; the writer's own
 * rules (own reports write nothing, owner target) are covered in server/utils/feedbackReadAudit.test.ts.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => {
      mockRefs.getHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const { mockRecordFeedbackRead, mockFindById } = vi.hoisted(() => ({
  mockRecordFeedbackRead: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@server/utils/feedbackReadAudit', () => ({ recordFeedbackRead: mockRecordFeedbackRead }));

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: mockFindById },
  FeedbackTextModel: { find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) },
}));

import '../read';

const FEEDBACK_ID = '507f1f77bcf86cd7994390fb';

const feedbackDoc = {
  id: FEEDBACK_ID,
  userId: 'reporter-1',
  toJSON: () => ({ id: FEEDBACK_ID, userId: 'reporter-1' }),
};

const call = () => {
  const { req, res } = createMocks({ method: 'GET', query: { id: FEEDBACK_ID } });
  const request = req as unknown as { ability: { can: () => boolean }; user: { id: string } };
  request.ability = { can: () => true };
  request.user = { id: 'admin-1' };
  return { req, res };
};

describe('GET /api/feedback/[id]/read - audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(feedbackDoc);
    mockRecordFeedbackRead.mockResolvedValue(undefined);
  });

  it('records the read with the report id and owner once, before responding', async () => {
    const { req, res } = call();
    await mockRefs.getHandler!(req, res);

    expect(mockRecordFeedbackRead).toHaveBeenCalledTimes(1);
    expect(mockRecordFeedbackRead).toHaveBeenCalledWith(req, [{ id: FEEDBACK_ID, userId: 'reporter-1' }]);
    expect(res._getStatusCode()).toBe(200);
  });

  it('fails the request and serves no text when the audit write fails', async () => {
    mockRecordFeedbackRead.mockRejectedValue(new Error('audit store down'));
    const { req, res } = call();

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow('audit store down');
    expect(res._isEndCalled()).toBe(false);
  });

  it('does not record a read for a report the caller cannot see', async () => {
    mockFindById.mockResolvedValue(null);
    const { req, res } = call();

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRecordFeedbackRead).not.toHaveBeenCalled();
  });
});
