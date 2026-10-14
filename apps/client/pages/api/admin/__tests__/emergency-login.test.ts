import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { USER_SECRET_FIELDS, USER_SUBFIELD_REDACTED_FIELDS } from '@bike4mind/common';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  userDoc: null as any,
}));

vi.mock('sst', () => ({ Resource: { EMERGENCY_LOGIN_ENABLED: { value: 'true' } } }));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn().mockResolvedValue(true) } }));
vi.mock('@bike4mind/database', () => ({
  User: { findOne: () => ({ select: () => Promise.resolve(mockRefs.userDoc) }) },
}));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_q: any, _s: any, next: any) => next() }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_q: any, _s: any, next: any) => next(),
}));
vi.mock('@server/utils/errors', () => ({ UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: vi.fn().mockResolvedValue({ accessToken: 'tok' }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

import '@pages/api/admin/emergency-login';

describe('POST /api/admin/emergency-login', () => {
  it('returns the user without any of the USER_SECRET_FIELDS', async () => {
    const secrets = { ...Object.fromEntries(USER_SECRET_FIELDS.map(f => [f, 'x'])), authProviders: [] };
    // These are rebuilt as a status-only subset, so the key survives; the planted value must not.
    const rebuilt: readonly string[] = USER_SUBFIELD_REDACTED_FIELDS;
    const plain = { id: 'u1', name: 'Admin', isAdmin: true, ...secrets };
    mockRefs.userDoc = { ...plain, tokenVersion: 0, toJSON: () => ({ ...plain }) };

    const { req, res } = createMocks({ method: 'POST', body: { username: 'admin', password: 'pw' } });
    (req as any).logger = { info: vi.fn(), warn: vi.fn() };
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.user).toMatchObject({ id: 'u1', name: 'Admin', accessToken: 'tok' });
    for (const f of USER_SECRET_FIELDS) {
      if (!rebuilt.includes(f)) expect(body.user).not.toHaveProperty(f);
    }
    expect(JSON.stringify(body.user)).not.toContain('"x"');
  });
});
