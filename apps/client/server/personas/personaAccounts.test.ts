import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  updateOne: vi.fn(),
  revokeUserSessions: vi.fn(),
  recordAdminAction: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    find: (...args: unknown[]) => ({ limit: () => ({ lean: () => h.find(...args) }) }),
    updateOne: h.updateOne,
    countDocuments: vi.fn(),
  },
  adminAuditLogRepository: {},
  adminSettingsRepository: {},
  authSessionRepository: {},
  realtimeConnectionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/server-utils/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: () => Promise.resolve({ matched: false }),
}));
const settingsValues = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: () => Promise.resolve({}),
  getSettingsValue: (name: string, _map: unknown, fallback: unknown) =>
    name in settingsValues.values ? settingsValues.values[name] : fallback,
}));
vi.mock('@bike4mind/services', () => ({
  adminAuditService: { recordAdminAction: h.recordAdminAction },
  userService: { revokeUserSessions: h.revokeUserSessions },
}));

import {
  MintPersonaBodySchema,
  personaEmailDomainRefusal,
  disableExpiredPersonas,
  readPersonaMintEnabled,
  isPersonaAccount,
  personaCapRefusal,
  personaIdentity,
  PERSONA_USERNAME_PATTERN,
} from './personaAccounts';

const NOW = new Date('2026-11-10T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  settingsValues.values = {};
});

describe('personaEmailDomainRefusal', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
  });

  it('refuses an internal staff domain, where a verified persona would pass as staff', async () => {
    process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example';
    expect(await personaEmailDomainRefusal('staff.example')).toBe('an internal staff domain');
  });

  it('refuses a regional public mail provider', async () => {
    expect(await personaEmailDomainRefusal('mail.ru')).toBe('a public mail provider');
  });

  it('accepts a dedicated persona subdomain', async () => {
    expect(await personaEmailDomainRefusal('personas.example.com')).toBeNull();
  });
});

describe('MintPersonaBodySchema', () => {
  it('accepts exactly { name }', () => {
    expect(MintPersonaBodySchema.safeParse({ name: 'alpha' }).success).toBe(true);
  });

  it.each([
    ['a role', { name: 'alpha', role: 'admin' }],
    ['the admin flag', { name: 'alpha', isAdmin: true }],
    ['admin permissions', { name: 'alpha', adminPermissions: ['users:delete'] }],
    ['a team', { name: 'alpha', team: 'core' }],
    ['credits', { name: 'alpha', initialCredits: 1_000_000 }],
    ['a plan level', { name: 'alpha', level: 'VIPUser' }],
    ['a username', { name: 'alpha', username: 'erik' }],
    ['an email', { name: 'alpha', email: 'erik@example.com' }],
    ['the persona flag', { name: 'alpha', isPersona: false }],
    ['tags', { name: 'alpha', tags: ['Developer'] }],
  ])('rejects a body that also carries %s', (_label, body) => {
    expect(MintPersonaBodySchema.safeParse(body).success).toBe(false);
  });

  it.each(['', 'Alpha', 'al pha', 'alpha-1', 'a'.repeat(25), 'admin@x', 'аlpha'])(
    'rejects the name %j, which would leave the persona- username shape',
    name => {
      expect(MintPersonaBodySchema.safeParse({ name }).success).toBe(false);
    }
  );
});

describe('personaIdentity', () => {
  it('builds a persona- username and an -e2e@test.com address off production', () => {
    const identity = personaIdentity('alpha', { production: false, emailDomain: null, now: NOW });
    expect(identity).toEqual({
      username: 'persona-alpha-4312000000',
      email: 'b4m-personaalpha-4312000000-e2e@test.com',
    });
    expect(identity!.username).toMatch(PERSONA_USERNAME_PATTERN);
  });

  it('uses <name>@<PersonaEmailDomain> on production', () => {
    expect(personaIdentity('alpha', { production: true, emailDomain: 'personas.example.com', now: NOW })).toEqual({
      username: 'persona-alpha-4312000000',
      email: 'alpha@personas.example.com',
    });
  });

  it('refuses on production when no domain is configured', () => {
    expect(personaIdentity('alpha', { production: true, emailDomain: null, now: NOW })).toBeNull();
  });

  it('refuses a name outside the pattern even if a caller skipped the schema', () => {
    expect(personaIdentity('Admin', { production: false, emailDomain: null, now: NOW })).toBeNull();
  });
});

describe('isPersonaAccount', () => {
  const persona = { username: 'persona-alpha-123', isPersona: true, isAdmin: false, adminPermissions: [] };

  it('accepts a flagged persona', () => {
    expect(isPersonaAccount(persona)).toBe(true);
  });

  it.each([
    ['no account', null],
    ['an account without the flag', { ...persona, isPersona: undefined }],
    ['a flagged account without a persona username', { ...persona, username: 'erik' }],
    ['a persona with admin', { ...persona, isAdmin: true }],
    ['a persona with delegated admin permissions', { ...persona, adminPermissions: ['users:delete'] }],
  ])('refuses %s', (_label, user) => {
    expect(isPersonaAccount(user as never)).toBe(false);
  });
});

describe('personaCapRefusal', () => {
  const settings = { dailyLimit: 20, maxLive: 40 };

  it('allows a mint under both caps', () => {
    expect(personaCapRefusal(settings, { mintedLast24h: 19, live: 39 })).toBeNull();
  });

  it('refuses at the daily cap', () => {
    expect(personaCapRefusal(settings, { mintedLast24h: 20, live: 0 })).toMatch(/per 24 hours/);
  });

  it('refuses at the live cap', () => {
    expect(personaCapRefusal(settings, { mintedLast24h: 0, live: 40 })).toMatch(/Live persona limit/);
  });

  it('refuses everything when the daily limit is 0', () => {
    expect(personaCapRefusal({ dailyLimit: 0, maxLive: 40 }, { mintedLast24h: 0, live: 0 })).not.toBeNull();
  });
});

describe('disableExpiredPersonas', () => {
  it('only queries enabled, flagged personas past their expiry', async () => {
    h.find.mockResolvedValue([]);
    await disableExpiredPersonas({ now: NOW });
    expect(h.find).toHaveBeenCalledWith(
      { isPersona: true, isBanned: { $ne: true }, personaExpiresAt: { $lte: NOW } },
      expect.anything()
    );
  });

  it('with all, drops the expiry filter so a live persona is banned too', async () => {
    h.find.mockResolvedValue([{ _id: 'u1', username: 'persona-a-1', email: 'a@x.test' }]);
    h.updateOne.mockResolvedValue({ modifiedCount: 1 });

    expect(await disableExpiredPersonas({ now: NOW, all: true })).toEqual({ disabled: 1 });
    expect(h.find).toHaveBeenCalledWith({ isPersona: true, isBanned: { $ne: true } }, expect.anything());
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining('minting turned off') }),
      expect.anything()
    );
  });

  it('with all, still skips a persona another run already disabled', async () => {
    h.find.mockResolvedValue([{ _id: 'u1', username: 'persona-a-1' }]);
    h.updateOne.mockResolvedValue({ modifiedCount: 0 });

    expect(await disableExpiredPersonas({ now: NOW, all: true })).toEqual({ disabled: 0 });
    expect(h.revokeUserSessions).not.toHaveBeenCalled();
    expect(h.recordAdminAction).not.toHaveBeenCalled();
  });

  it('suspends, signs out and audits each expired persona', async () => {
    h.find.mockResolvedValue([{ _id: 'u1', username: 'persona-a-1', email: 'a@x.test' }]);
    h.updateOne.mockResolvedValue({ modifiedCount: 1 });

    expect(await disableExpiredPersonas({ now: NOW })).toEqual({ disabled: 1 });
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'u1', isPersona: true, isBanned: { $ne: true } },
      { $set: { isBanned: true } }
    );
    expect(h.revokeUserSessions).toHaveBeenCalledWith('u1', expect.anything());
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.persona.expired', target: expect.objectContaining({ id: 'u1' }) }),
      expect.anything()
    );
  });

  it('skips a persona another run already disabled', async () => {
    h.find.mockResolvedValue([{ _id: 'u1', username: 'persona-a-1' }]);
    h.updateOne.mockResolvedValue({ modifiedCount: 0 });

    expect(await disableExpiredPersonas({ now: NOW })).toEqual({ disabled: 0 });
    expect(h.revokeUserSessions).not.toHaveBeenCalled();
    expect(h.recordAdminAction).not.toHaveBeenCalled();
  });
});

describe('readPersonaMintEnabled', () => {
  it('is false by default', async () => {
    expect(await readPersonaMintEnabled()).toBe(false);
  });

  it('is true when the setting is true', async () => {
    settingsValues.values = { PersonaMintEnabled: true };
    expect(await readPersonaMintEnabled()).toBe(true);
  });
});
