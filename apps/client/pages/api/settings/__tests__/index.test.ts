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
// since its rows include (encrypted) provider API keys.
const mockLean = vi.fn();
const mockFind = vi.fn(() => ({ lean: mockLean }));
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));
// Sensitive values are stored encrypted; decryptAtRest passes the plaintext test fixtures
// through unchanged (they are not in ciphertext format).
vi.mock('@bike4mind/utils/security', () => ({
  decryptAtRest: (v: unknown) => v,
}));

import handler from '../index';
import { SENSITIVE_SETTING_MASK } from '@bike4mind/common';

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

describe('GET /api/settings (admin-only, sensitive values masked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLean.mockResolvedValue(SECRET_ROWS);
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

  it('returns the collection to an admin with sensitive values masked, non-sensitive in full', async () => {
    const { req, res } = makeReq({ isAdmin: true });

    await (handler as HandlerFn)(req, res);

    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);

    const body = res._getJSONData() as Array<{ settingName: string; settingValue: unknown }>;
    const secret = body.find(s => s.settingName === 'openaiDemoKey');
    expect(secret?.settingValue).toBe(`${SENSITIVE_SETTING_MASK}leak`);
    // The stored secret must never leave the server, even to an admin, through this route.
    expect(JSON.stringify(body)).not.toContain('sk-live-should-never-leak');

    const nonSensitive = body.find(s => s.settingName === 'EnableArtifacts');
    expect(nonSensitive?.settingValue).toBe(true);
  });
});
