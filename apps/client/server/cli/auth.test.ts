import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
}));

const cacheStore = new Map<string, { value: number; expiresAt: number }>();

vi.mock('@bike4mind/database', () => ({
  User: { findById: vi.fn() },
  userApiKeyRepository: { findById: vi.fn() },
  cacheRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { validateUserApiKey: vi.fn() },
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
import { checkRateLimit, verifyJwtToken, verifyEmbedApiKey, verifyEmbedKeyById } from './auth';
import { cacheService, userApiKeyService } from '@bike4mind/services';
import { User, userApiKeyRepository } from '@bike4mind/database';
import { extractApiKeyFromHeaders } from '@server/utils/apiKeyRateLimitCheck';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType } from '@bike4mind/common';

const userId = 'user-abc';
const key = `rate-limit:ws-auth:${userId}`;
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
  const activeKeyDoc = {
    id: 'key-1',
    userId: 'u1',
    scopes: [ApiKeyScope.EMBED_CHAT],
    status: ApiKeyStatus.ACTIVE,
    rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
    billingOwnerType: CreditHolderType.Organization,
    organizationId: 'org-1',
    agentId: 'agent-1',
    allowedOrigins: ['https://example.com'],
  };

  beforeEach(() => vi.mocked(userApiKeyRepository.findById).mockReset());

  it('resolves an active org-owned embed key by id', async () => {
    vi.mocked(userApiKeyRepository.findById).mockResolvedValue(activeKeyDoc as never);
    const info = await verifyEmbedKeyById('key-1');
    expect(info).toMatchObject({ keyId: 'key-1', agentId: 'agent-1', organizationId: 'org-1' });
  });

  it('rejects a revoked/disabled key (revocation caught within the token TTL)', async () => {
    vi.mocked(userApiKeyRepository.findById).mockResolvedValue({
      ...activeKeyDoc,
      status: ApiKeyStatus.DISABLED,
    } as never);
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/not active/);
  });

  it('rejects a missing key', async () => {
    vi.mocked(userApiKeyRepository.findById).mockResolvedValue(null as never);
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/not active/);
  });

  it('rejects a key lacking the embed:chat scope', async () => {
    vi.mocked(userApiKeyRepository.findById).mockResolvedValue({
      ...activeKeyDoc,
      scopes: [ApiKeyScope.AI_CHAT],
    } as never);
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/embed:chat/);
  });

  it('rejects a non-org embed key by id', async () => {
    vi.mocked(userApiKeyRepository.findById).mockResolvedValue({
      ...activeKeyDoc,
      billingOwnerType: CreditHolderType.User,
      organizationId: undefined,
    } as never);
    await expect(verifyEmbedKeyById('key-1')).rejects.toThrow(/organization-owned/);
  });
});
