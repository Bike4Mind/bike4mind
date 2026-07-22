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
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

// The real gateEmbedBrandingWrite runs; only its entitlement seam is stubbed,
// so these tests exercise the actual strip logic through the route. The database
// barrel is stubbed because the gate's module also exports the owner resolver.
const requestHasEntitlement = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('@server/entitlements', () => ({ requestHasEntitlement }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {}, userRepository: {} }));

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

  describe('whitelabel write gate (epic #41 Phase D)', () => {
    beforeEach(() => {
      requestHasEntitlement.mockReset();
      requestHasEntitlement.mockResolvedValue(false);
    });

    it('strips hideBranding:true for an unentitled caller, keeping other fields', async () => {
      const { req, res } = patch('key-1', { branding: { displayName: 'Acme', hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { displayName: 'Acme', hideBranding: false } }),
        expect.anything()
      );
    });

    it('preserves hideBranding:true for an entitled caller', async () => {
      requestHasEntitlement.mockResolvedValue(true);
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: true } }),
        expect.anything()
      );
    });

    it('strips hideBranding when the entitlement lookup rejects (fail closed)', async () => {
      requestHasEntitlement.mockRejectedValue(new Error('lookup down'));
      const { req, res } = patch('key-1', { branding: { hideBranding: true } });
      await mockRefs.patchHandler!(req, res);
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('forwards an omitted branding as undefined (stored hideBranding never cleared)', async () => {
      const { req, res } = patch('key-1', { agentId: 'agent-2' });
      await mockRefs.patchHandler!(req, res);
      expect(requestHasEntitlement).not.toHaveBeenCalled();
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: undefined }),
        expect.anything()
      );
    });

    it('never consults the entitlement for branding without a hideBranding elevation', async () => {
      const { req, res } = patch('key-1', { branding: { primaryColor: '#336699' } });
      await mockRefs.patchHandler!(req, res);
      expect(requestHasEntitlement).not.toHaveBeenCalled();
      expect(updateEmbedKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { primaryColor: '#336699' } }),
        expect.anything()
      );
    });
  });
});
