import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PATCH /api/user-api-keys/[id] (embed-key configure, Phase E): the "nothing to
 * update" guard, the host-aware origin screen (validateEmbedKeyOrigins, run for
 * real here), and the analytics `updatedFields` that reflects only the fields
 * actually sent. The service is mocked - these assertions are about what the
 * route screens, forwards, and logs, not the service's own invariants.
 */

// PUBLISH_HOST is read from SERVER_DOMAIN at module load, so set it before imports.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN = 'bike4mind.com';
});

const mockRefs = vi.hoisted(() => ({ patchHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: () => chain,
    post: () => chain,
    patch: (fn: any) => {
      mockRefs.patchHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const updateEmbedKey = vi.hoisted(() =>
  vi.fn((_userId?: unknown, params?: Record<string, unknown>) => ({
    id: (params as any)?.keyId ?? 'key-1',
    name: 'widget',
    agentId: (params as any)?.agentId,
    allowedOrigins: (params as any)?.allowedOrigins,
    branding: (params as any)?.branding,
  }))
);
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { updateEmbedKey } }));
// The route reads the stored key via findByUserIdAndId - both for the branding
// echo-vs-elevation decision and (post-#891) for the owner ref the gate resolves.
// Default to no stored key.
const userApiKeyRepository = vi.hoisted(() => ({ findByUserIdAndId: vi.fn().mockResolvedValue(null) }));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository }));
const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

// The real gateEmbedBrandingWrite AND embedKeyOwnerHasEntitlement run; only the
// leaf entitlement source (getUserEntitlements) and the owner-doc lookups are
// stubbed, so these tests exercise the actual OWNER-scoped strip logic through
// the route - a caller's isAdmin no longer bypasses, only the resolved owner's
// plan counts (#891).
const getUserEntitlements = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@server/entitlements', () => ({ getUserEntitlements }));
const userRepository = vi.hoisted(() => ({ findById: vi.fn() }));
const organizationRepository = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ organizationRepository, userRepository }));

import { CreditHolderType } from '@bike4mind/common';
import '@pages/api/user-api-keys/[id]/index';

function patch(id: string | undefined, body: unknown) {
  const { req, res } = createMocks({ method: 'PATCH', query: id === undefined ? {} : { id }, body });
  (req as any).user = { id: 'u1', isAdmin: false };
  return { req, res };
}

describe('PATCH /api/user-api-keys/[id] - embed-key configure', () => {
  beforeEach(() => {
    updateEmbedKey.mockClear();
    logEvent.mockClear();
  });

  it('updates the provided fields with normalized origins and returns 200', async () => {
    const { req, res } = patch('key-1', {
      agentId: 'agent-2',
      allowedOrigins: ['https://example.com', 'https://Example.com'],
      branding: { displayName: 'Acme' },
    });
    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(updateEmbedKey).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        keyId: 'key-1',
        agentId: 'agent-2',
        // validateEmbedKeyOrigins lowercased + deduped before forwarding.
        allowedOrigins: ['https://example.com'],
        branding: { displayName: 'Acme' },
      }),
      expect.anything()
    );
  });

  it('logs only the fields actually sent in updatedFields', async () => {
    const { req, res } = patch('key-1', { agentId: 'agent-2' });
    await mockRefs.patchHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ updatedFields: ['agentId'] }) }),
      expect.anything()
    );
  });

  it('rejects an empty body with 400 (nothing to update) and never calls the service', async () => {
    const { req, res } = patch('key-1', {});
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Nothing to update/i);
    expect(updateEmbedKey).not.toHaveBeenCalled();
  });

  it('rejects a missing key id with 400', async () => {
    const { req, res } = patch(undefined, { agentId: 'agent-2' });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Invalid key ID/i);
    expect(updateEmbedKey).not.toHaveBeenCalled();
  });

  it('rejects a first-party (self) host origin with 400 and never calls the service', async () => {
    const { req, res } = patch('key-1', { allowedOrigins: ['https://app.bike4mind.com'] });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Bike4Mind host/i);
    expect(updateEmbedKey).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-https) origin with 400 and never calls the service', async () => {
    const { req, res } = patch('key-1', { allowedOrigins: ['http://example.com'] });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Invalid embed origin/i);
    expect(updateEmbedKey).not.toHaveBeenCalled();
  });

  // The service is mocked, so these prove the ROUTE screens branding itself
  // (validateEmbedBranding) rather than relying on the service re-validation.
  it('rejects branding with a javascript: logo URL and never calls the service', async () => {
    const { req, res } = patch('key-1', { branding: { logoUrl: 'javascript:alert(1)' } });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Invalid branding/i);
    expect(updateEmbedKey).not.toHaveBeenCalled();
  });

  it('rejects branding with a non-hex primaryColor and never calls the service', async () => {
    const { req, res } = patch('key-1', { branding: { primaryColor: 'red;}body{}' } });
    await expect(mockRefs.patchHandler!(req, res)).rejects.toThrow(/Invalid branding/i);
    expect(updateEmbedKey).not.toHaveBeenCalled();
  });

  // Post-#891 the write gate is OWNER-scoped: it authorizes the hideBranding
  // elevation against the key's billing owner (same rule as the serve/read gate)
  // rather than the acting caller, so an admin/developer can no longer persist a
  // hideBranding the read side would strip.
  describe('whitelabel write gate - owner-scoped (#891)', () => {
    const OWNER = 'owner-1';
    beforeEach(() => {
      getUserEntitlements.mockReset();
      getUserEntitlements.mockResolvedValue([]); // owner not entitled by default
      userRepository.findById.mockReset();
      userRepository.findById.mockResolvedValue({ id: OWNER });
      organizationRepository.findById.mockReset();
      userApiKeyRepository.findByUserIdAndId.mockReset();
      // Personal key owned by OWNER, no stored hideBranding.
      userApiKeyRepository.findByUserIdAndId.mockResolvedValue({ userId: OWNER, branding: undefined });
    });

    it('strips hideBranding:true when the key OWNER is unentitled, keeping other fields', async () => {
      const { req, res } = patch('key-1', { branding: { displayName: 'Acme', hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(getUserEntitlements).toHaveBeenCalled();
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { displayName: 'Acme', hideBranding: false } }),
        expect.anything()
      );
    });

    // The core #891 regression: an admin CALLER no longer bypasses the gate. Only
    // the resolved owner's plan decides, so an admin configuring a key for an
    // unentitled owner cannot persist a hideBranding:true the read side strips.
    it('strips hideBranding:true even when the CALLER is a Super Admin, if the owner is unentitled', async () => {
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      (req as any).user = { id: 'u1', isAdmin: true };
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('preserves hideBranding:true when the key OWNER is entitled', async () => {
      getUserEntitlements.mockResolvedValue(['embed:whitelabel']);
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: true } }),
        expect.anything()
      );
    });

    // An org-billed key's entitlement is the org billing owner's, never the
    // minter's - a minter entitled personally cannot white-label an unentitled org.
    it('resolves the ORG billing owner (not the minter) for an org-billed key', async () => {
      userApiKeyRepository.findByUserIdAndId.mockResolvedValue({
        userId: 'minter',
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-1',
        branding: undefined,
      });
      organizationRepository.findById.mockResolvedValue({ userId: 'org-owner' });
      userRepository.findById.mockImplementation(async (id: string) => ({ id }));
      getUserEntitlements.mockImplementation(async (owner: any) =>
        owner?.id === 'minter' ? ['embed:whitelabel'] : []
      );
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(organizationRepository.findById).toHaveBeenCalledWith('org-1');
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('strips hideBranding when owner resolution rejects (fail closed)', async () => {
      userRepository.findById.mockRejectedValue(new Error('lookup down'));
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('strips hideBranding when the key is not found / not the callers (fail closed)', async () => {
      userApiKeyRepository.findByUserIdAndId.mockResolvedValue(null);
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      // No owner to resolve - the null-existing guard strips without a lookup.
      expect(getUserEntitlements).not.toHaveBeenCalled();
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('forwards an omitted branding as undefined (stored hideBranding never cleared)', async () => {
      const { req, res } = patch('key-1', { agentId: 'agent-2' });
      await mockRefs.patchHandler!(req, res);
      expect(userApiKeyRepository.findByUserIdAndId).not.toHaveBeenCalled();
      expect(getUserEntitlements).not.toHaveBeenCalled();
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: undefined }),
        expect.anything()
      );
    });

    it('never resolves the owner for branding without a hideBranding elevation', async () => {
      const { req, res } = patch('key-1', { branding: { primaryColor: '#336699' } });
      await mockRefs.patchHandler!(req, res);
      expect(userApiKeyRepository.findByUserIdAndId).not.toHaveBeenCalled();
      expect(getUserEntitlements).not.toHaveBeenCalled();
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { primaryColor: '#336699' } }),
        expect.anything()
      );
    });

    // A stored hideBranding:true must survive an unrelated branding edit - the
    // client echoes the stored flag, and the gate treats that echo as not-an-
    // elevation rather than clobbering white-label the org already earned.
    it('preserves a stored hideBranding:true when an unentitled owner edits an unrelated branding field (echo)', async () => {
      userApiKeyRepository.findByUserIdAndId.mockResolvedValue({ userId: OWNER, branding: { hideBranding: true } });
      const { req, res } = patch('key-1', { branding: { primaryColor: '#0a7f3f', hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { primaryColor: '#0a7f3f', hideBranding: true } }),
        expect.anything()
      );
      // An echo is not an elevation, so owner resolution is not even needed.
      expect(getUserEntitlements).not.toHaveBeenCalled();
    });

    it('still strips a genuine elevation (stored not true) for an unentitled owner', async () => {
      userApiKeyRepository.findByUserIdAndId.mockResolvedValue({ userId: OWNER, branding: { hideBranding: false } });
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });
  });
});
