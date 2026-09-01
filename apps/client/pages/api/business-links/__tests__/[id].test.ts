import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Types } from 'mongoose';

/**
 * The PUT puts a caller-supplied `categoryId` into the update payload. Update payloads
 * cast just like filters do, and casting runs before validators, so `runValidators` does
 * not cover it - the guard has to be in the handler.
 */

// Collapse the baseApi().put().delete() chain and capture the PUT handler.
const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  updatePayload: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/content', () => ({
  ResearchLink: {
    findByIdAndUpdate: (_id: unknown, update: unknown) => {
      mockRefs.updatePayload = update;
      return Promise.resolve({ id: _id });
    },
    findByIdAndDelete: () => Promise.resolve(null),
  },
}));

vi.mock('@server/utils/errors', () => ({ ensureAdmin: () => {} }));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/business-links/[id]';

function invokePut(body: Record<string, string>) {
  const { req, res } = createMocks({
    method: 'PUT',
    query: { id: new Types.ObjectId().toString() },
    body,
    url: '/api/business-links/x',
  });
  (req as any).user = { isAdmin: true };
  return { req, res };
}

describe('PUT /api/business-links/[id] - categoryId validation', () => {
  beforeEach(() => {
    mockRefs.updatePayload = undefined;
  });

  it('rejects a malformed categoryId with 400 instead of letting the update payload cast', async () => {
    expect(mockRefs.putHandler).toBeTypeOf('function');

    const { req, res } = invokePut({ categoryId: 'not-an-object-id' });
    await mockRefs.putHandler!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ message: 'Invalid category ID format' });
    // Nothing reached the database, so no CastError could be thrown.
    expect(mockRefs.updatePayload).toBeUndefined();
  });

  it('passes a well-formed categoryId through to the update', async () => {
    const categoryId = new Types.ObjectId().toString();
    const { req, res } = invokePut({ categoryId });
    await mockRefs.putHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.updatePayload).toMatchObject({ categoryId });
  });

  // The payload is built unconditionally, so a falsy-but-present value still reaches the
  // cast even though `if (categoryId && ...)` would skip it.
  it.each([['zero', 0], ['false', false]])(
    'rejects a falsy-but-present categoryId (%s)',
    async (_label, value) => {
      const { req, res } = invokePut({ categoryId: value as unknown as string });
      await mockRefs.putHandler!(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(mockRefs.updatePayload).toBeUndefined();
    }
  );

  // '' is what the edit form sends when no categories have loaded, and it means "no
  // category". It casts (so it cannot reach the payload as-is) but null is the clean way to
  // say the same thing, so it is normalized rather than rejected.
  it('normalizes an empty categoryId onto null instead of 400ing the edit form', async () => {
    const { req, res } = invokePut({ categoryId: '' });
    await mockRefs.putHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.updatePayload).toMatchObject({ categoryId: null });
  });

  it('allows null through, which mongoose casts cleanly to clear the field', async () => {
    const { req, res } = invokePut({ categoryId: null as unknown as string });
    await mockRefs.putHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.updatePayload).toMatchObject({ categoryId: null });
  });

  it('leaves an update with no categoryId alone', async () => {
    const { req, res } = invokePut({ name: 'renamed' });
    await mockRefs.putHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.updatePayload).toMatchObject({ name: 'renamed' });
  });
});
