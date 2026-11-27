// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';

const baseApiOptions = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.value = options;
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => unknown) => {
        middlewares.push(middleware);
        return chain;
      },
      put: (handler: (req: unknown, res: unknown) => Promise<unknown>) => async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => {});
        return handler(req, res);
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockFindById = vi.fn();
const mockSetAccountSegment = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    setAccountSegment: (...args: unknown[]) => mockSetAccountSegment(...args),
  },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import handler from '../segment';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const REASON = 'Pilot or partner access';

const call = async (body: unknown, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'org-1' }, body });
  Object.assign(req, { user });
  await (handler as HandlerFn)(req, res);
  return { req, res };
};

describe('PUT /api/admin/organizations/[id]/segment', () => {
  it('declares first-party JWT-only authentication and only PUT', () => {
    expect(baseApiOptions.value).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['PUT'] });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'org-1', name: 'Acme' });
  });

  it('refuses a delegate without settings:manage before writing', async () => {
    await expect(
      call(
        { accountSegment: 'partner', reason: REASON },
        { id: 'delegate', isAdmin: false, adminPermissions: ['support:read'] }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockSetAccountSegment).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it.each(['internal', 'partner'] as const)('sets %s on a customer org and audits the change', async segment => {
    const { res } = await call({ accountSegment: segment, reason: REASON });

    expect(mockSetAccountSegment).toHaveBeenCalledWith('org-1', segment);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.segment.changed',
        reason: REASON,
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        changes: [{ field: 'accountSegment', before: 'customer', after: segment }],
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ accountSegment: segment });
  });

  it('unsets the field when the org goes back to customer', async () => {
    mockFindById.mockResolvedValue({ id: 'org-1', name: 'Acme', accountSegment: 'partner' });

    await call({ accountSegment: 'customer', reason: REASON });

    expect(mockSetAccountSegment).toHaveBeenCalledWith('org-1', null);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'accountSegment', before: 'partner', after: 'customer' }] })
    );
  });

  it.each([
    ['customer', {}],
    ['partner', { accountSegment: 'partner' }],
  ])('treats %s to the same value as a no-op with no write and no audit', async (segment, org) => {
    mockFindById.mockResolvedValue({ id: 'org-1', name: 'Acme', ...org });

    await call({ accountSegment: segment, reason: REASON });

    expect(mockSetAccountSegment).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown org', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(call({ accountSegment: 'partner', reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockSetAccountSegment).not.toHaveBeenCalled();
  });

  it.each([{}, { accountSegment: 'vip' }, null])('rejects an invalid body %j with a 400', async body => {
    await expect(call(body)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockSetAccountSegment).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['too short', { reason: 'no' }],
  ])('rejects a %s reason with no write and no audit', async (_label, extra) => {
    await expect(call({ accountSegment: 'partner', ...extra })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockSetAccountSegment).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('records the change strictly', () => {
    expect(ADMIN_AUDIT_CATALOGUE['org.segment.changed']).toMatchObject({ write: 'strict' });
  });
});
