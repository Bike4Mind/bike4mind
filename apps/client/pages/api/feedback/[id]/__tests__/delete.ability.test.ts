import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import errorHandler from '@server/middlewares/errorHandler';

/**
 * The second call site of the `!req.ability` guard; the rationale for the status and the log
 * level lives on the throw in ../../index.ts, and the sibling pin in ../../__tests__/list.test.ts.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

// Hoisted alongside the mock factory below, which vitest lifts above this file's const bindings.
const { mockFindById } = vi.hoisted(() => ({ mockFindById: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    delete: (fn: unknown) => {
      mockRefs.deleteHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: mockFindById, deleteOne: vi.fn() },
  FeedbackTextModel: { deleteOne: vi.fn() },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '../delete';

// Mirrors baseApi's next-connect router, whose onError is errorHandler, so the throw is asserted
// as the HTTP response the app would actually send rather than as an uncaught rejection.
const runHandler = async (req: unknown, res: unknown) => {
  try {
    await mockRefs.deleteHandler!(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
};

describe('DELETE /api/feedback/[id] - a missing ability is a typed 404, not an untyped 500', () => {
  it('returns 404 and logs at warn without touching the database', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: '507f1f77bcf86cd7994390fb' } });
    // delete.ts reads req.user.id before the ability guard, so the request needs a user but no
    // ability - the shape the guard exists for.
    (req as unknown as { user: { id: string } }).user = { id: 'u1' };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    (req as unknown as { logger: unknown }).logger = logger;
    (req as unknown as { requestId: string }).requestId = 'test-request-id';

    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Ability not found');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('404'));
    expect(logger.error).not.toHaveBeenCalled();
    // Separates this 404 from the route's other two, which both read the record first.
    expect(mockFindById).not.toHaveBeenCalled();
  });
});
