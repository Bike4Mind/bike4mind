import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { USER_SECRET_FIELDS } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, get: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const mockSelect = vi.fn();
const mockLean = vi.fn<() => Promise<Record<string, unknown>[]>>(() =>
  Promise.resolve([{ username: 'u', email: 'u@example.com' }])
);
vi.mock('@bike4mind/database', () => {
  const query: any = {
    select: (...a: any[]) => {
      mockSelect(...a);
      return query;
    },
    sort: () => query,
    skip: () => query,
    limit: () => query,
    lean: () => mockLean(),
  };
  return { User: { find: () => query, countDocuments: () => Promise.resolve(1) } };
});

import handler from '../email-verification';

// The admin tab renders sent/expiry timestamps; the token and secret fields are not part of the response.
const DISPLAYED_TIMESTAMPS = [
  'emailVerificationSentAt',
  'emailVerificationExpires',
  'pendingEmailSentAt',
  'pendingEmailExpires',
];

const call = async () => {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as unknown as Record<string, unknown>).user = { id: 'a1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('GET /api/admin/users/email-verification', () => {
  it('selects only the display fields and none of the user secret fields', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    const selected = String(mockSelect.mock.calls[0][0]).split(/\s+/);
    for (const f of USER_SECRET_FIELDS) {
      if (DISPLAYED_TIMESTAMPS.includes(f)) continue;
      expect(selected).not.toContain(f);
    }
  });
  it('strips fields that are not part of the response contract', async () => {
    mockLean.mockResolvedValueOnce([
      { _id: 'u1', username: 'u', email: 'u@example.com', emailVerificationToken: 'tok', passwordHash: 'hash' },
    ]);
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.users).toEqual([{ _id: 'u1', username: 'u', email: 'u@example.com' }]);
    expect(body.pagination).toEqual({ page: 1, limit: 20, totalPages: 1, totalCount: 1 });
  });
});
