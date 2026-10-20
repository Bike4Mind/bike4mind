import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const h = vi.hoisted(() => ({
  append: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminAuditLogRepository: { append: h.append } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findById: h.findById } }));

import { recordAdminActionFromRequest, systemAuditActor, type RecordAdminActionFromRequestInput } from './adminAudit';

type RequestOverrides = {
  user?: Record<string, unknown>;
  apiKeyInfo?: { keyId: string };
  url?: string;
};

const buildRequest = (overrides: RequestOverrides = {}): Request =>
  ({
    user: {
      id: 'admin-1',
      username: 'admin-user',
      name: 'Admin One',
      email: 'admin@example.com',
      isAdmin: true,
    },
    headers: { 'user-agent': 'vitest-agent', 'cloudfront-viewer-address': '203.0.113.7:4711' },
    socket: { remoteAddress: '198.51.100.1' },
    requestId: 'req-1',
    url: '/api/admin/users/u1/credits',
    logger: { error: vi.fn() },
    ...overrides,
  }) as unknown as Request;

const baseInput: RecordAdminActionFromRequestInput = {
  action: 'user.credits.adjusted',
  target: { kind: 'user', id: 'u1', displayName: 'Target User' },
  summary: 'Granted credits',
};

const appended = () => h.append.mock.calls[0][0];

describe('recordAdminActionFromRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.append.mockImplementation(async (entry: Record<string, unknown>) => ({ id: 'entry-1', ...entry }));
  });

  it('records a plain admin as the actor', async () => {
    await recordAdminActionFromRequest(buildRequest(), baseInput);

    expect(appended().actor).toEqual({
      kind: 'user',
      scope: 'platform',
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin One',
      wasAdmin: true,
    });
    expect(appended().context).toMatchObject({
      userAgent: 'vitest-agent',
      requestId: 'req-1',
      route: '/api/admin/users/u1/credits',
      source: 'admin_ui',
    });
    expect(appended().context.ip).toBe('203.0.113.7');
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('honours actorScope and falls back to username when name is empty', async () => {
    const req = buildRequest({ user: { id: 'a', username: 'fallback', name: '', email: null, isAdmin: true } });
    await recordAdminActionFromRequest(req, { ...baseInput, actorScope: 'organization' });

    expect(appended().actor).toMatchObject({ scope: 'organization', name: 'fallback', email: undefined });
  });

  it('attributes an impersonated request to the real admin', async () => {
    h.findById.mockResolvedValue({
      id: 'real-admin',
      username: 'real',
      name: 'Real Admin',
      email: 'real@example.com',
      isAdmin: true,
    });
    const req = buildRequest({
      user: {
        id: 'customer-1',
        username: 'cust',
        name: 'Customer',
        email: 'c@example.com',
        isAdmin: false,
        impersonatedBy: 'real-admin',
      },
    });

    await recordAdminActionFromRequest(req, baseInput);

    expect(h.findById).toHaveBeenCalledWith('real-admin');
    expect(appended().actor).toEqual({
      kind: 'user',
      scope: 'platform',
      userId: 'real-admin',
      email: 'real@example.com',
      name: 'Real Admin',
      wasAdmin: true,
      impersonatedUserId: 'customer-1',
    });
  });

  it('falls back to an unknown admin when the impersonator cannot be found', async () => {
    h.findById.mockResolvedValue(null);
    const req = buildRequest({
      user: { id: 'customer-1', username: 'cust', name: 'Customer', isAdmin: false, impersonatedBy: 'ghost-admin' },
    });

    await recordAdminActionFromRequest(req, baseInput);

    expect(appended().actor).toMatchObject({
      kind: 'user',
      userId: 'ghost-admin',
      name: 'Unknown admin',
      impersonatedUserId: 'customer-1',
    });
  });

  it('records an API-key caller as an apiKey actor with api_key source', async () => {
    await recordAdminActionFromRequest(buildRequest({ apiKeyInfo: { keyId: 'key-9' } }), baseInput);

    expect(appended().actor).toMatchObject({ kind: 'apiKey', apiKeyId: 'key-9', userId: 'admin-1' });
    expect(appended().context.source).toBe('api_key');
  });

  it('writes the fallback actor and logs when the impersonator lookup rejects', async () => {
    h.findById.mockRejectedValue(new Error('db down'));
    const req = buildRequest({
      user: { id: 'customer-1', username: 'cust', name: 'Customer', isAdmin: false, impersonatedBy: 'real-admin' },
    });

    const entry = await recordAdminActionFromRequest(req, baseInput);

    expect(entry).not.toBeNull();
    expect(appended().actor).toMatchObject({
      userId: 'real-admin',
      name: 'Unknown admin',
      impersonatedUserId: 'customer-1',
    });
    expect(req.logger.error).toHaveBeenCalledWith(
      '[ADMIN_AUDIT_ACTOR_LOOKUP_FAILED]',
      expect.objectContaining({ impersonatedBy: 'real-admin' })
    );
  });

  it('combines impersonation with an API key', async () => {
    h.findById.mockResolvedValue({
      id: 'real-admin',
      username: 'real',
      name: 'Real Admin',
      email: null,
      isAdmin: true,
    });
    const req = buildRequest({
      user: { id: 'customer-1', username: 'cust', name: 'C', isAdmin: false, impersonatedBy: 'real-admin' },
      apiKeyInfo: { keyId: 'key-9' },
    });

    await recordAdminActionFromRequest(req, baseInput);

    expect(appended().actor).toMatchObject({
      kind: 'apiKey',
      apiKeyId: 'key-9',
      userId: 'real-admin',
      impersonatedUserId: 'customer-1',
    });
    expect(appended().context.source).toBe('api_key');
  });

  it('throws when the request is unauthenticated', async () => {
    const req = buildRequest();
    delete req.user;

    await expect(recordAdminActionFromRequest(req, baseInput)).rejects.toThrow(/authenticated/);
    expect(h.append).not.toHaveBeenCalled();
  });

  it('strips the query string from the route', async () => {
    await recordAdminActionFromRequest(buildRequest({ url: '/api/admin/x?token=secret&a=1' }), baseInput);

    expect(appended().context.route).toBe('/api/admin/x');
  });
});

describe('systemAuditActor', () => {
  it('builds a platform system actor', () => {
    expect(systemAuditActor('cron')).toEqual({ kind: 'system', scope: 'platform', name: 'cron', wasAdmin: false });
  });
});
