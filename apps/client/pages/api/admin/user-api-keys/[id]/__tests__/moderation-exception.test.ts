import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStatus, BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  guard: null as null | ((req: unknown, res: unknown, next: () => void) => void),
  findKey: vi.fn(),
  findException: vi.fn(),
  setException: vi.fn(),
  findUser: vi.fn(),
  audit: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    const chain = {
      use: (guard: unknown) => {
        h.guard ??= guard as typeof h.guard;
        return chain;
      },
      put: (fn: typeof h.handler) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  realtimeConnectionRepository: {},
  withTransaction: h.withTransaction,
}));
vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: {
    findById: h.findKey,
    findModerationException: h.findException,
    setModerationException: h.setException,
  },
}));
vi.mock('@bike4mind/services', () => ({ authSessionService: { endRealtimeConnections: vi.fn() } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async () => {
  const { BadRequestError: BadRequest } = await import('@bike4mind/common');
  return {
    parseAdminActionReason: (reason: unknown) => {
      if (typeof reason !== 'string' || !reason) throw new BadRequest('reason required');
      return reason;
    },
    recordAdminActionFromRequest: h.audit,
  };
});

await import('../moderation-exception');

const activeKey = {
  id: 'key-1',
  userId: 'owner-1',
  name: 'Pipeline key',
  keyPrefix: 'b4m_live_abc',
  status: ApiKeyStatus.ACTIVE,
};
const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'PUT',
  query: { id: 'key-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { categories: ['violence', 'violence/graphic'], reason: 'Approved integration key' },
  logger: { warn: vi.fn() },
  ...overrides,
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const guarded = async (req: unknown) => {
  h.guard!(req, {}, () => {});
  return h.handler!(req, response());
};

describe('PUT /api/admin/user-api-keys/[id]/moderation-exception', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.findKey.mockResolvedValue(activeKey);
    h.findException.mockResolvedValue(null);
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
  });

  it('is jwt-only and rejects non-admins before any read', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', allowedMethods: ['PUT'] });
    await expect(guarded(request({ user: { id: 'u', isAdmin: false } }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.findKey).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    const req = request({ body: { categories: ['violence'] } });
    await expect(h.handler!(req, response())).rejects.toBeInstanceOf(BadRequestError);
    expect(h.setException).not.toHaveBeenCalled();
  });

  it.each([
    ['a category off the shared list', ['violence', 'hate']],
    ['a repeated category', ['violence', 'violence']],
    ['a non-array', 'violence'],
    ['a missing field', undefined],
  ])('rejects %s without writing', async (_label, categories) => {
    const req = request({ body: { categories, reason: 'Approved integration key' } });
    await expect(h.handler!(req, response())).rejects.toBeInstanceOf(BadRequestError);
    expect(h.findKey).not.toHaveBeenCalled();
    expect(h.setException).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('404s for a missing key', async () => {
    h.findKey.mockResolvedValueOnce(null);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(NotFoundError);
    expect(h.setException).not.toHaveBeenCalled();
  });

  it('sets the exception as the acting admin and audits it inside the transaction', async () => {
    const req = request();
    const res = response();
    await h.handler!(req, res);

    expect(h.withTransaction).toHaveBeenCalledTimes(1);
    expect(h.setException).toHaveBeenCalledExactlyOnceWith('key-1', {
      categories: ['violence', 'violence/graphic'],
      reason: 'Approved integration key',
      setBy: 'admin-1',
      setAt: expect.any(Date),
    });
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        action: 'user.api_key.moderation_exception_updated',
        target: { kind: 'user', id: 'owner-1', displayName: 'owner@example.com' },
        reason: 'Approved integration key',
        changes: [{ field: 'moderationException.categories', before: [], after: ['violence', 'violence/graphic'] }],
        details: { keyId: 'key-1', keyPrefix: 'b4m_live_abc', keyName: 'Pipeline key' },
      })
    );
    expect(res.json).toHaveBeenCalledWith({
      keyId: 'key-1',
      moderationException: expect.objectContaining({ categories: ['violence', 'violence/graphic'], setBy: 'admin-1' }),
    });
  });

  it('clears the exception with an empty list and audits the previous categories', async () => {
    h.findException.mockResolvedValueOnce({ moderationException: { categories: ['violence'] } });
    const req = request({ body: { categories: [], reason: 'Key repurposed' } });
    const res = response();
    await h.handler!(req, res);

    expect(h.setException).toHaveBeenCalledExactlyOnceWith('key-1', null);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        changes: [{ field: 'moderationException.categories', before: ['violence'], after: [] }],
      })
    );
    expect(res.json).toHaveBeenCalledWith({ keyId: 'key-1', moderationException: null });
  });

  it('fails the request when the audit row cannot be written', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    await expect(h.handler!(request(), response())).rejects.toThrow('audit down');
  });
});
