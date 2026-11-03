import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById } = vi.hoisted(() => ({ mockFindById: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: () => ({ populate: () => ({ select: mockFindById }) }),
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: (fn: (req: unknown, res: unknown) => unknown) => fn,
    };
    return chain;
  },
}));

import handler from '../index';

const SUBJECT_ID = 'subject-1';
const throttle = { tier: 'shadow', reason: 'x', source: 'admin' };
const riskSignals = [{ type: 'signup_honeypot', at: new Date('2025-01-01T00:00:00Z') }];

const run = async (viewer: { id: string; isAdmin: boolean }) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: SUBJECT_ID } });
  (req as unknown as { user: typeof viewer }).user = viewer;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res._getJSONData() as Record<string, unknown>;
};

describe('GET /api/users/[id] restricted-tier fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({
      id: SUBJECT_ID,
      username: 'subject',
      name: 'Subject',
      email: 'subject@example.com',
      throttle,
      riskSignals,
      toObject() {
        const { toObject: _t, ...rest } = this as Record<string, unknown>;
        return rest;
      },
    });
  });

  it('exposes throttle and riskSignals to an admin viewer', async () => {
    const body = await run({ id: 'admin-1', isAdmin: true });

    expect(body.throttle).toMatchObject({ tier: 'shadow' });
    expect(body.riskSignals).toHaveLength(1);
  });

  it('withholds them from the subject viewing their own profile', async () => {
    const body = await run({ id: SUBJECT_ID, isAdmin: false });

    expect(body.username).toBe('subject');
    expect(body).not.toHaveProperty('throttle');
    expect(body).not.toHaveProperty('riskSignals');
  });
});
