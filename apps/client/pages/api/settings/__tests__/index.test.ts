// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@bike4mind/common';

// baseApi: unwrap the chain so handler.get(fn) just returns fn.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: function () {
      return this;
    },
    get: (fn: unknown) => fn,
  }),
}));

// AdminSettings: the full settings collection. It MUST NOT be queried on a denied call,
// since its rows include unredacted provider API keys.
const mockFind = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

import handler from '../index';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

function makeReq(user?: { isAdmin?: boolean }) {
  // node-mocks-http keeps its rich response type here (for statusCode / _getJSONData
  // assertions); the handler's params are `unknown`, so req/res pass through unchanged.
  const { req, res } = createMocks({ method: 'GET' });
  if (user !== undefined) {
    (req as Record<string, unknown>).user = user;
  }
  return { req, res };
}

const SECRET_ROWS = [
  { settingName: 'openaiDemoKey', settingValue: 'sk-live-should-never-leak' },
  { settingName: 'EnableArtifacts', settingValue: true },
];

describe('GET /api/settings (admin-only, full unredacted collection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue(SECRET_ROWS);
  });

  it('rejects a non-admin with 403 and never queries the settings collection', async () => {
    const { req, res } = makeReq({ isAdmin: false });

    await expect((handler as HandlerFn)(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({ statusCode: 403 });

    // The critical guarantee: we bail out before touching any secret-bearing data.
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller (no req.user) with 403 and never queries settings', async () => {
    const { req, res } = makeReq(); // no user attached

    await expect((handler as HandlerFn)(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns the full settings collection to an admin', async () => {
    const { req, res } = makeReq({ isAdmin: true });

    await (handler as HandlerFn)(req, res);

    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual(SECRET_ROWS);
  });
});
