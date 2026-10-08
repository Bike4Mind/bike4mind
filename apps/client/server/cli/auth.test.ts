import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError, ForbiddenError } from '@server/utils/errors';

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
}));

const cacheStore = new Map<string, { value: number; expiresAt: number }>();

vi.mock('@bike4mind/database', () => ({
  User: { findById: vi.fn() },
  userApiKeyRepository: { findById: vi.fn() },
  cacheRepository: {},
}));

vi.mock('@bike4mind/services', async importOriginal => ({
  // Real `userService.accountBlockReasons` drives the account-state gate; the rest of the barrel
  // loads alongside it (its db/config deps are mocked here).
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  // Real kill-switch + token-type comparisons so the tests exercise actual enforcement (not stubs).
  isTokenVersionCurrent: (a?: number, b?: number) => (a ?? 0) === (b ?? 0),
  isTokenTypeAcceptable: (t: unknown, expected: string) => t === undefined || t === expected,
  userApiKeyService: { validateUserApiKey: vi.fn(), validateUserApiKeyById: vi.fn() },
  cacheService: {
    get: vi.fn(async ({ key }: { key: string }) => {
      const entry = cacheStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        cacheStore.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async ({ key, value, ttl }: { key: string; value: number; ttl: number }) => {
      cacheStore.set(key, { value, expiresAt: Date.now() + ttl });
      return value;
    }),
    ttl: vi.fn(async ({ key }: { key: string }) => {
      const entry = cacheStore.get(key);
      if (!entry) return 0;
      return entry.expiresAt - Date.now();
    }),
  },
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  extractApiKeyFromHeaders: vi.fn(),
  checkApiKeyRateLimit: vi.fn(),
}));

import jwt from 'jsonwebtoken';
import {
  checkRateLimit,
  resolveRateLimitClient,
  verifyApiKey,
  verifyJwtToken,
  verifyEmbedApiKey,
  verifyEmbedKeyById,
} from './auth';
import { cacheService, userApiKeyService } from '@bike4mind/services';
import { User } from '@bike4mind/database';
import { extractApiKeyFromHeaders } from '@server/utils/apiKeyRateLimitCheck';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';

const userId = 'user-abc';
const key = `rate-limit:ws-auth:${userId}`;
const desktopKey = `rate-limit:ws-auth:desktop:${userId}`;
const HOUR_MS = 60 * 60_000;

describe('checkRateLimit (JWT per-user rate limiter)', () => {
  beforeEach(() => {
    cacheStore.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('fixed-window TTL behavior', () => {
    it('seeds a fresh window with the full TTL on the first request', async () => {
      vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await checkRateLimit(userId);

      const entry = cacheStore.get(key);
      expect(entry).toBeDefined();
      expect(entry!.value).toBe(1);
      expect(entry!.expiresAt - Date.now()).toBe(HOUR_MS);
    });

    it('preserves the original window expiry on subsequent increments — does NOT slide the TTL forward', async () => {
      vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await checkRateLimit(userId);
      const windowOpensAt = Date.now();
      const originalExpiry = cacheStore.get(key)!.expiresAt;

      // Advance 30 min and make another request - the window should still
      // expire exactly 60 min from the FIRST request, not 60 min from now.
      vi.setSystemTime(new Date(windowOpensAt + 30 * 60_000));
      await checkRateLimit(userId);

      const entry = cacheStore.get(key)!;
      expect(entry.value).toBe(2);
      expect(entry.expiresAt).toBe(originalExpiry);
    });

    it('opens a fresh window once the previous one expires', async () => {
      vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await checkRateLimit(userId);
      // Jump past the original window
      vi.setSystemTime(new Date(Date.now() + HOUR_MS + 1));

      await checkRateLimit(userId);

      const entry = cacheStore.get(key)!;
      expect(entry.value).toBe(1);
      expect(entry.expiresAt - Date.now()).toBe(HOUR_MS);
    });
  });

  describe('per-source caps', () => {
    it('allows up to 100 requests for an unspecified source (the legacy default)', async () => {
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(userId);
      }
      await expect(checkRateLimit(userId)).rejects.toThrow(/Rate limit exceeded/);
    });

    it("allows up to 100 requests for source: 'web'", async () => {
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(userId, 'web');
      }
      await expect(checkRateLimit(userId, 'web')).rejects.toThrow(/Rate limit exceeded/);
    });

    it("allows up to 1000 requests for source: 'cli' (CLI tool loops need a much higher ceiling)", async () => {
      // Spot-check: 100 should be well under the CLI cap
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(userId, 'cli');
      }
      // Still allowed - would have thrown under the legacy 100-cap
      await expect(checkRateLimit(userId, 'cli')).resolves.toBeUndefined();

      // Drive to the cap and confirm it throws on the 1001st request
      for (let i = 102; i <= 1000; i++) {
        await checkRateLimit(userId, 'cli');
      }
      await expect(checkRateLimit(userId, 'cli')).rejects.toThrow(/Rate limit exceeded/);
    });

    // Seeded rather than looped: the boundary is the only interesting call, and 6000 serial
    // awaits to reach it cost more than they prove.
    const seedDesktop = (value: number) => cacheStore.set(desktopKey, { value, expiresAt: Date.now() + 3_600_000 });

    it('carries the desktop app to 6000, where source api alone would stop at 100', async () => {
      seedDesktop(5999);
      await expect(checkRateLimit(userId, 'api', { client: 'b4m-desktop/0.1.0' })).resolves.toBeUndefined();
      await expect(checkRateLimit(userId, 'api', { client: 'b4m-desktop/0.1.0' })).rejects.toThrow(
        /Rate limit exceeded/
      );
    });

    it('counts the desktop app on its own bucket, so a busy desktop cannot lock the CLI out', async () => {
      seedDesktop(5999);
      await checkRateLimit(userId, 'api', { client: 'b4m-desktop/0.1.0' });

      // The raised ceiling must not be spent on the counter the CLI and every other JWT surface
      // read, or a desktop session past 1000 would exhaust that user's CLI budget.
      expect(cacheStore.get(key)).toBeUndefined();
      await expect(checkRateLimit(userId, 'cli')).resolves.toBeUndefined();
      expect(cacheStore.get(key)!.value).toBe(1);
    });

    it('keeps the 100 cap for any other API client', async () => {
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(userId, 'api', { client: 'my-script/1.0' });
      }
      await expect(checkRateLimit(userId, 'api', { client: 'my-script/1.0' })).rejects.toThrow(/Rate limit exceeded/);
    });
  });

  describe('resolveRateLimitClient', () => {
    it('prefers the User-Agent over x-b4m-client', () => {
      expect(resolveRateLimitClient({ 'user-agent': 'b4m-desktop/0.1.0', 'x-b4m-client': 'other/1' })).toBe(
        'b4m-desktop/0.1.0'
      );
    });

    it('falls back to x-b4m-client, and is undefined when neither is set', () => {
      expect(resolveRateLimitClient({ 'x-b4m-client': 'b4m-desktop/0.1.0' })).toBe('b4m-desktop/0.1.0');
      expect(resolveRateLimitClient({})).toBeUndefined();
    });
  });

  describe('buckets', () => {
    it('keeps a bucketed counter apart from the shared one, in both directions', async () => {
      // A CLI session at 1000 on the shared counter must not spend the tools budget.
      for (let i = 0; i < 1000; i++) {
        await checkRateLimit(userId, 'cli');
      }
      await expect(checkRateLimit(userId, undefined, { bucket: 'tools' })).resolves.toBeUndefined();
      expect(cacheStore.get(key)!.value).toBe(1000);
      expect(cacheStore.get(`rate-limit:ws-auth:tools:${userId}`)!.value).toBe(1);
    });

    it('applies the source cap to the bucketed counter', async () => {
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(userId, undefined, { bucket: 'tools' });
      }
      await expect(checkRateLimit(userId, undefined, { bucket: 'tools' })).rejects.toThrow(/Rate limit exceeded/);
      expect(cacheStore.has(key)).toBe(false);
    });
  });

  describe('error message', () => {
    it('reports the remaining window in seconds (not a reset-to-full hour)', async () => {
      vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

      // Burn through the cap
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(userId);
      }

      // 45 minutes into the window - 15 min should remain
      vi.setSystemTime(new Date(Date.now() + 45 * 60_000));

      await expect(checkRateLimit(userId)).rejects.toThrow(/Try again in 900 seconds/);
    });
  });

  it('uses cacheService.ttl (not a hardcoded fallback) to compute the increment TTL', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await checkRateLimit(userId); // seeds
    const ttlCallsBefore = vi.mocked(cacheService.ttl).mock.calls.length;
    await checkRateLimit(userId); // increment
    const ttlCallsAfter = vi.mocked(cacheService.ttl).mock.calls.length;

    expect(ttlCallsAfter).toBeGreaterThan(ttlCallsBefore);
  });
});

describe('verifyJwtToken (P0-B policy consent gate)', () => {
  const sign = (id: string) => jwt.sign({ id }, 'test-secret');
  const mockUser = (over: Record<string, unknown>) => ({
    id: 'u1',
    email: 'a@b.com',
    username: 'a',
    aupAcceptedVersion: undefined,
    isSystem: false,
    ...over,
  });

  beforeEach(() => {
    vi.mocked(User.findById).mockReset();
  });

  it('rejects a JWT for an account with no recorded acceptance (fail-closed on the LLM surface)', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: undefined }));
    await expect(verifyJwtToken(sign('u1'))).rejects.toThrow('Policy acceptance required');
  });

  it('rejects when aupAcceptedVersion is null/empty (absent or blank both mean not accepted)', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: null }));
    await expect(verifyJwtToken(sign('u1'))).rejects.toThrow('Policy acceptance required');
  });

  it('accepts a JWT for an account with a recorded version', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1' }));
    await expect(verifyJwtToken(sign('u1'))).resolves.toMatchObject({ id: 'u1' });
  });

  it('accepts a grandfathered account (sentinel version passes the gate)', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'grandfathered' }));
    await expect(verifyJwtToken(sign('u1'))).resolves.toMatchObject({ id: 'u1' });
  });

  it('accepts a system account regardless of acceptance (service users never attest)', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ isSystem: true, aupAcceptedVersion: undefined }));
    await expect(verifyJwtToken(sign('u1'))).resolves.toMatchObject({ id: 'u1' });
  });

  it('rejects a first-factor-only (mfaPending) token before hitting the DB', async () => {
    await expect(verifyJwtToken(jwt.sign({ id: 'u1', mfaPending: true }, 'test-secret'))).rejects.toThrow(
      'MFA verification required'
    );
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token whose tokenVersion is stale relative to the user (revocation kill-switch)', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1', tokenVersion: 3 }));
    await expect(verifyJwtToken(jwt.sign({ id: 'u1', tokenVersion: 1 }, 'test-secret'))).rejects.toThrow(
      'Session expired'
    );
  });

  it('accepts a token whose tokenVersion matches the user', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1', tokenVersion: 3 }));
    await expect(verifyJwtToken(jwt.sign({ id: 'u1', tokenVersion: 3 }, 'test-secret'))).resolves.toMatchObject({
      id: 'u1',
    });
  });

  it('accepts a legacy token with no tokenVersion against a v0 user (self-expiring grace)', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1' }));
    await expect(verifyJwtToken(sign('u1'))).resolves.toMatchObject({ id: 'u1' });
  });

  it('rejects a refresh token presented as an access bearer (wrong token type)', async () => {
    await expect(verifyJwtToken(jwt.sign({ id: 'u1', typ: 'refresh' }, 'test-secret'))).rejects.toThrow(
      'Invalid token type'
    );
  });

  it('accepts a token explicitly typed as access', async () => {
    vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1' }));
    await expect(verifyJwtToken(jwt.sign({ id: 'u1', typ: 'access' }, 'test-secret'))).resolves.toMatchObject({
      id: 'u1',
    });
  });

  it('rejects a relying-party OAuth access token before hitting the DB (oauthRouteGate does not cover this surface)', async () => {
    // Wiring guard: this primitive backs the CLI/LLM surfaces the route gate never runs on, so the
    // kind:oauth rejection here is the ONLY thing keeping a scope-bound OAuth token off them.
    await expect(verifyJwtToken(jwt.sign({ id: 'u1', kind: 'oauth' }, 'test-secret'))).rejects.toThrow(
      'OAuth access tokens are not accepted on this endpoint'
    );
    expect(User.findById).not.toHaveBeenCalled();
  });

  // A still-valid session JWT for a consented account must still be refused once the account is
  // banned/disputed/suspended: ban does not bump tokenVersion, and the WS/CLI completion surfaces
  // fall back to this primitive. Same gate verifyApiKey applies via assertOwnerAccountUsable.
  describe('account state (ban / dispute / suspension) on the JWT/WS/CLI fallback', () => {
    it('rejects a banned owner even with accepted policy and a current tokenVersion', async () => {
      vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1', isBanned: true }));
      await expect(verifyJwtToken(sign('u1'))).rejects.toThrow('User not found or banned');
      await expect(verifyJwtToken(sign('u1'))).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('rejects a chargeback/dispute-pending owner', async () => {
      vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1', disputePending: true }));
      await expect(verifyJwtToken(sign('u1'))).rejects.toThrow('dispute resolution');
      await expect(verifyJwtToken(sign('u1'))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rejects a content-policy-suspended owner', async () => {
      vi.mocked(User.findById).mockResolvedValue(
        mockUser({ aupAcceptedVersion: 'v1', moderation: { status: 'suspended' } })
      );
      await expect(verifyJwtToken(sign('u1'))).rejects.toThrow('suspended for repeated content-policy');
      await expect(verifyJwtToken(sign('u1'))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('accepts a usable account (not banned, disputed, or suspended)', async () => {
      vi.mocked(User.findById).mockResolvedValue(mockUser({ aupAcceptedVersion: 'v1' }));
      await expect(verifyJwtToken(sign('u1'))).resolves.toMatchObject({ id: 'u1' });
    });
  });
});

describe('verifyEmbedApiKey (embed credential-class gates)', () => {
  const rateLimit = { requestsPerMinute: 10, requestsPerDay: 100 };
  const validEmbed = {
    isValid: true,
    userId: 'u1',
    keyId: 'k1',
    scopes: [ApiKeyScope.EMBED_CHAT],
    rateLimit,
    billingOwnerType: CreditHolderType.Organization,
    organizationId: 'org-1',
    agentId: 'agent-1',
    allowedOrigins: ['https://example.com'],
  };

  beforeEach(() => {
    vi.mocked(extractApiKeyFromHeaders).mockReturnValue('b4m_live_embedkey');
    vi.mocked(userApiKeyService.validateUserApiKey).mockReset();
    // The key owner's account state is now checked on this path too.
    vi.mocked(User.findById).mockReset();
    vi.mocked(User.findById).mockResolvedValue({ id: 'u1', isBanned: false });
  });

  it('returns the bound agentId and allowedOrigins on a valid org-owned embed key', async () => {
    vi.mocked(userApiKeyService.validateUserApiKey).mockResolvedValue(validEmbed);
    const info = await verifyEmbedApiKey({});
    expect(info.agentId).toBe('agent-1');
    expect(info.allowedOrigins).toEqual(['https://example.com']);
    expect(info.organizationId).toBe('org-1');
  });

  it('rejects a key without the embed:chat scope', async () => {
    vi.mocked(userApiKeyService.validateUserApiKey).mockResolvedValue({
      ...validEmbed,
      scopes: [ApiKeyScope.AI_CHAT],
    });
    await expect(verifyEmbedApiKey({})).rejects.toThrow(/embed:chat/);
  });

  it('rejects a user-owned embed key (org-only)', async () => {
    vi.mocked(userApiKeyService.validateUserApiKey).mockResolvedValue({
      ...validEmbed,
      billingOwnerType: CreditHolderType.User,
      organizationId: undefined,
    });
    await expect(verifyEmbedApiKey({})).rejects.toThrow(/organization-owned/);
  });

  it('rejects an org-typed key with no organizationId', async () => {
    vi.mocked(userApiKeyService.validateUserApiKey).mockResolvedValue({
      ...validEmbed,
      organizationId: undefined,
    });
    await expect(verifyEmbedApiKey({})).rejects.toThrow(/organization-owned/);
  });

  it('rejects an embed key not bound to an agent (fail closed)', async () => {
    vi.mocked(userApiKeyService.validateUserApiKey).mockResolvedValue({
      ...validEmbed,
      agentId: undefined,
    });
    await expect(verifyEmbedApiKey({})).rejects.toThrow(/not bound to an agent/);
  });
});

describe('verifyEmbedKeyById (session-token path re-validation)', () => {
  // verifyEmbedKeyById delegates the status/expiry/last-used gates to the shared
  // validateUserApiKeyById; these cases drive that service result, then assert the
  // embed-specific scope + credential-class checks layered on top.
  const validResult = {
    isValid: true,
    userId: 'u1',
    keyId: 'key-1',
    scopes: [ApiKeyScope.EMBED_CHAT],
    rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
    billingOwnerType: CreditHolderType.Organization,
    organizationId: 'org-1',
    agentId: 'agent-1',
    allowedOrigins: ['https://example.com'],
  };

  beforeEach(() => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockReset();
    vi.mocked(User.findById).mockReset();
    vi.mocked(User.findById).mockResolvedValue({ id: 'u1', isBanned: false });
  });

  it('resolves an active org-owned embed key by id', async () => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockResolvedValue(validResult);
    const info = await verifyEmbedKeyById('key-1');
    expect(info).toMatchObject({ keyId: 'key-1', agentId: 'agent-1', organizationId: 'org-1' });
  });

  it('rejects a revoked/disabled key (revocation caught within the token TTL)', async () => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockResolvedValue({ isValid: false, reason: 'disabled' });
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/disabled/);
  });

  it('rejects an expired key (shared gate with the raw-key path)', async () => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockResolvedValue({ isValid: false, reason: 'expired' });
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/expired/);
  });

  it('rejects a missing key', async () => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockResolvedValue({ isValid: false, reason: 'not_found' });
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/not_found/);
  });

  it('rejects a key lacking the embed:chat scope', async () => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockResolvedValue({
      ...validResult,
      scopes: [ApiKeyScope.AI_CHAT],
    });
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/embed:chat/);
  });

  it('rejects a non-org embed key by id', async () => {
    vi.mocked(userApiKeyService.validateUserApiKeyById).mockResolvedValue({
      ...validResult,
      billingOwnerType: CreditHolderType.User,
      organizationId: undefined,
    });
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/organization-owned/);
  });
});

describe('api-key account-state gates (mirrors apiKeyAuth)', () => {
  const validKey = {
    isValid: true,
    userId: 'u1',
    keyId: 'k1',
    scopes: [ApiKeyScope.AI_CHAT],
    rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
  };

  beforeEach(() => {
    vi.mocked(extractApiKeyFromHeaders).mockReturnValue('b4m_live_somekey');
    vi.mocked(userApiKeyService.validateUserApiKey).mockReset();
    vi.mocked(userApiKeyService.validateUserApiKey).mockResolvedValue(validKey);
    vi.mocked(User.findById).mockReset();
  });

  it('admits a key whose owner is in good standing', async () => {
    vi.mocked(User.findById).mockResolvedValue({ id: 'u1', isBanned: false });
    await expect(verifyApiKey({})).resolves.toMatchObject({ keyId: 'k1' });
  });

  // The thrown error class + message must stay in sync with apiKeyAuth.ts: a bare
  // Error would flatten to a 500 (or the wrong status) on the surfaces this path backs.
  it('refuses a banned owner with an UnauthorizedError', async () => {
    vi.mocked(User.findById).mockResolvedValue({ id: 'u1', isBanned: true });
    await expect(verifyApiKey({})).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verifyApiKey({})).rejects.toThrow(/banned/i);
  });

  it('refuses an owner with a pending payment dispute with a ForbiddenError', async () => {
    vi.mocked(User.findById).mockResolvedValue({ id: 'u1', isBanned: false, disputePending: true });
    await expect(verifyApiKey({})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(verifyApiKey({})).rejects.toThrow(/dispute/i);
  });

  it('refuses a moderation-suspended owner with a ForbiddenError and the full appeal message', async () => {
    vi.mocked(User.findById).mockResolvedValue({
      id: 'u1',
      isBanned: false,
      moderation: { status: 'suspended' },
    });
    await expect(verifyApiKey({})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(verifyApiKey({})).rejects.toThrow(/contact support to appeal/i);
  });

  it('refuses a key whose owner no longer exists', async () => {
    vi.mocked(User.findById).mockResolvedValue(null);
    await expect(verifyApiKey({})).rejects.toThrow(/not found/i);
  });
});
