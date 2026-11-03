import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const h = vi.hoisted(() => ({
  append: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { append: h.append },
  adminSettingsRepository: { findAll: async () => [], findBySettingNames: async () => [] },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findById: h.findById } }));

import {
  ADMIN_ACTION_REASON_MISSING_MESSAGE,
  denySelfAdminAction,
  parseAdminActionReason,
  recordAdminActionFromRequest,
  systemAuditActor,
  userAuditTarget,
  type RecordAdminActionFromRequestInput,
} from './adminAudit';
import { ADMIN_REASON_PRESETS, composeAdminReason } from '@client/app/components/admin/shared/adminReason';

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

describe('parseAdminActionReason', () => {
  it('points at a reload when no reason key was sent', () => {
    expect(() => parseAdminActionReason(undefined)).toThrow(ADMIN_ACTION_REASON_MISSING_MESSAGE);
    expect(ADMIN_ACTION_REASON_MISSING_MESSAGE).toMatch(/reload/i);
  });

  it('keeps the field-level message for an explicitly sent null', () => {
    expect(() => parseAdminActionReason(null)).toThrow('A reason is required');
  });

  it.each(['', '   ', 'abc'])('keeps the field-level message when a reason was sent but is unusable (%j)', value => {
    expect(() => parseAdminActionReason(value)).toThrow('A reason of at least 5 characters is required');
  });

  it('returns a trimmed valid reason', () => {
    expect(parseAdminActionReason('  Reproducing a ticket  ')).toBe('Reproducing a ticket');
  });

  // ReasonPicker sends a preset on its own as the whole reason, so the audit entry must keep it verbatim.
  it.each(Object.values(ADMIN_REASON_PRESETS).flat())('accepts the ReasonPicker preset %j unchanged', preset => {
    expect(parseAdminActionReason(preset)).toBe(preset);
    expect(parseAdminActionReason(composeAdminReason({ preset, note: ' ticket 42 ' }))).toBe(`${preset}: ticket 42`);
  });
});

describe('systemAuditActor', () => {
  it('builds a platform system actor', () => {
    expect(systemAuditActor('cron')).toEqual({ kind: 'system', scope: 'platform', name: 'cron', wasAdmin: false });
  });
});

describe('denySelfAdminAction', () => {
  const denied = { action: 'user.mfa.denied', attempted: 'user.mfa.reset', target: baseInput.target } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    h.append.mockImplementation(async (entry: Record<string, unknown>) => ({ id: 'entry-1', ...entry }));
  });

  it('throws the generic 403 message by default', async () => {
    await expect(denySelfAdminAction(buildRequest(), denied)).rejects.toThrow(
      'Admins cannot perform this action on their own account.'
    );
  });

  it('throws a caller-supplied message', async () => {
    await expect(denySelfAdminAction(buildRequest(), { ...denied, message: 'Use settings.' })).rejects.toThrow(
      'Use settings.'
    );
  });
});

describe('userAuditTarget', () => {
  beforeEach(() => h.findById.mockReset());

  it('labels the target with the email, then the username, then the id', async () => {
    h.findById.mockResolvedValueOnce({ email: 'a@example.com', username: 'a' });
    expect(await userAuditTarget('u1')).toEqual({ kind: 'user', id: 'u1', displayName: 'a@example.com' });
    h.findById.mockResolvedValueOnce({ username: 'a' });
    expect((await userAuditTarget('u1')).displayName).toBe('a');
    h.findById.mockResolvedValueOnce(null);
    expect((await userAuditTarget('u1')).displayName).toBe('u1');
  });
});
