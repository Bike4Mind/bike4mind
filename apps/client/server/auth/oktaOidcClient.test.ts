import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock openid-client - must use inline factory
vi.mock('openid-client', () => {
  // Real class so `error instanceof client.ClientError` works in production code.
  class ClientError extends Error {
    code?: string;
    constructor(message: string, options?: { code?: string; cause?: unknown }) {
      super(message, options as ErrorOptions);
      this.name = 'ClientError';
      this.code = options?.code;
    }
  }
  return {
    discovery: vi.fn(),
    buildAuthorizationUrl: vi.fn(),
    authorizationCodeGrant: vi.fn(),
    fetchUserInfo: vi.fn(),
    randomPKCECodeVerifier: vi.fn(() => 'test-code-verifier-43-chars-minimum-length'),
    calculatePKCECodeChallenge: vi.fn(async () => 'test-code-challenge'),
    ClientSecretPost: vi.fn(() => 'client-secret-post-auth'),
    ClientError,
  };
});

// Mock Config - must use inline factory
vi.mock('@server/utils/config', () => ({
  Config: {
    OKTA_AUDIENCE: 'https://test.okta.com',
    OKTA_CLIENT_ID: 'test-client-id',
    OKTA_CLIENT_SECRET: 'test-client-secret',
  },
}));

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock database
vi.mock('@bike4mind/database', () => ({
  identityProviderRepository: {
    findById: vi.fn(),
    findAll: vi.fn(),
    updateIDP: vi.fn(),
  },
}));

// Import after mocks
import * as openidClient from 'openid-client';
import { identityProviderRepository } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import {
  generatePkceParams,
  getOktaConfigWithFallback,
  getOidcConfiguration,
  clearConfigurationCache,
  extractOktaConfigFromIdp,
  getOktaConfigStatus,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  OktaConfig,
} from './oktaOidcClient';

describe('oktaOidcClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigurationCache();
  });

  afterEach(() => {
    clearConfigurationCache();
  });

  describe('generatePkceParams', () => {
    it('should generate PKCE code verifier and challenge', async () => {
      const params = await generatePkceParams();

      expect(params.codeVerifier).toBe('test-code-verifier-43-chars-minimum-length');
      expect(params.codeChallenge).toBe('test-code-challenge');
      expect(openidClient.randomPKCECodeVerifier).toHaveBeenCalled();
      expect(openidClient.calculatePKCECodeChallenge).toHaveBeenCalledWith(
        'test-code-verifier-43-chars-minimum-length'
      );
    });

    it('should use openid-client PKCE utilities', async () => {
      vi.mocked(openidClient.randomPKCECodeVerifier).mockReturnValueOnce('another-verifier');
      vi.mocked(openidClient.calculatePKCECodeChallenge).mockResolvedValueOnce('another-challenge');

      const params = await generatePkceParams();

      expect(params.codeVerifier).toBe('another-verifier');
      expect(params.codeChallenge).toBe('another-challenge');
    });
  });

  describe('getOktaConfigWithFallback', () => {
    describe('with database IDP', () => {
      it('should return database config when IDP exists with valid oktaConfig', async () => {
        const mockIdp = {
          id: 'idp-123',
          oktaConfig: {
            audience: 'https://db.okta.com',
            clientId: 'db-client-id',
            clientSecret: 'db-client-secret',
          },
        };
        vi.mocked(identityProviderRepository.findById).mockResolvedValue(mockIdp as any);

        const result = await getOktaConfigWithFallback('idp-123');

        expect(result.source).toBe('database');
        expect(result.config).toEqual({
          audience: 'https://db.okta.com',
          clientId: 'db-client-id',
          clientSecret: 'db-client-secret',
          authServerId: 'default',
          useOrgAuthServer: false,
        });
        expect(result.idp).toBe(mockIdp);
        expect(identityProviderRepository.findById).toHaveBeenCalledWith('idp-123');
      });

      it('should return database config with useOrgAuthServer when set', async () => {
        const mockIdp = {
          id: 'idp-org',
          oktaConfig: {
            audience: 'https://org.okta.com',
            clientId: 'org-client-id',
            clientSecret: 'org-client-secret',
            useOrgAuthServer: true,
          },
        };
        vi.mocked(identityProviderRepository.findById).mockResolvedValue(mockIdp as any);

        const result = await getOktaConfigWithFallback('idp-org');

        expect(result.source).toBe('database');
        expect(result.config).toEqual({
          audience: 'https://org.okta.com',
          clientId: 'org-client-id',
          clientSecret: 'org-client-secret',
          authServerId: 'default',
          useOrgAuthServer: true,
        });
      });

      it('should fallback to SST when IDP not found', async () => {
        vi.mocked(identityProviderRepository.findById).mockResolvedValue(null);

        const result = await getOktaConfigWithFallback('non-existent-idp');

        expect(result.source).toBe('sst');
        expect(result.config).toEqual({
          audience: 'https://test.okta.com',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          authServerId: 'default',
          useOrgAuthServer: false,
        });
        expect(result.idp).toBeUndefined();
      });

      it('should fallback to SST when IDP has incomplete oktaConfig', async () => {
        vi.mocked(identityProviderRepository.findById).mockResolvedValue({
          id: 'idp-123',
          oktaConfig: {
            audience: 'https://db.okta.com',
            // Missing clientId and clientSecret
          },
        } as any);

        const result = await getOktaConfigWithFallback('idp-123');

        expect(result.source).toBe('sst');
      });

      it('should fallback to SST when database throws error', async () => {
        vi.mocked(identityProviderRepository.findById).mockRejectedValue(new Error('Database error'));

        const result = await getOktaConfigWithFallback('idp-123');

        expect(result.source).toBe('sst');
        expect(result.config?.clientId).toBe('test-client-id');
      });
    });

    describe('with SST fallback', () => {
      it('should return SST config when no IDP ID provided', async () => {
        const result = await getOktaConfigWithFallback();

        expect(result.source).toBe('sst');
        expect(result.config).toEqual({
          audience: 'https://test.okta.com',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          authServerId: 'default',
          useOrgAuthServer: false,
        });
        expect(identityProviderRepository.findById).not.toHaveBeenCalled();
      });

      it('should use the org-level auth server when OKTA_USE_ORG_AUTH_SERVER is true', async () => {
        // The flag lets a stage whose tenant has no custom auth server go straight
        // to org-level discovery, skipping the custom /oauth2/default attempt that
        // would otherwise fail and log ERROR on every cold start.
        (Config as { OKTA_USE_ORG_AUTH_SERVER?: string }).OKTA_USE_ORG_AUTH_SERVER = 'true';
        try {
          const result = await getOktaConfigWithFallback();
          expect(result.source).toBe('sst');
          expect(result.config).toEqual({
            audience: 'https://test.okta.com',
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            authServerId: undefined,
            useOrgAuthServer: true,
          });
        } finally {
          delete (Config as { OKTA_USE_ORG_AUTH_SERVER?: string }).OKTA_USE_ORG_AUTH_SERVER;
        }
      });

      it('should return SST config for sst-fallback IDP ID', async () => {
        const result = await getOktaConfigWithFallback('sst-fallback');

        expect(result.source).toBe('sst');
        expect(identityProviderRepository.findById).not.toHaveBeenCalled();
      });
    });
  });

  describe('getOidcConfiguration', () => {
    const mockConfig = { serverMetadata: vi.fn() };

    beforeEach(() => {
      vi.mocked(openidClient.discovery).mockResolvedValue(mockConfig as any);
    });

    it('should construct issuer URL with default auth server', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://example.okta.com',
        clientId: 'client-123',
        clientSecret: 'secret-123',
      };

      await getOidcConfiguration(oktaConfig);

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.okta.com/oauth2/default',
        }),
        'client-123',
        expect.anything(),
        expect.anything()
      );
    });

    it('should construct issuer URL with custom auth server', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://example.okta.com/',
        clientId: 'client-123',
        clientSecret: 'secret-123',
        authServerId: 'custom-server',
      };

      await getOidcConfiguration(oktaConfig);

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.okta.com/oauth2/custom-server',
        }),
        'client-123',
        expect.anything(),
        expect.anything()
      );
    });

    it('should normalize audience URL by removing trailing slashes', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://example.okta.com///',
        clientId: 'client-123',
        clientSecret: 'secret-123',
      };

      await getOidcConfiguration(oktaConfig);

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.okta.com/oauth2/default',
        }),
        'client-123',
        expect.anything(),
        expect.anything()
      );
    });

    it('should cache OIDC configuration', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://cache-test.okta.com',
        clientId: 'cache-client',
        clientSecret: 'cache-secret',
      };

      // First call - should trigger discovery
      await getOidcConfiguration(oktaConfig);
      expect(openidClient.discovery).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      await getOidcConfiguration(oktaConfig);
      expect(openidClient.discovery).toHaveBeenCalledTimes(1);
    });

    it('should use separate cache entries for different configs', async () => {
      const config1: OktaConfig = {
        audience: 'https://tenant1.okta.com',
        clientId: 'client-1',
        clientSecret: 'secret-1',
      };

      const config2: OktaConfig = {
        audience: 'https://tenant2.okta.com',
        clientId: 'client-2',
        clientSecret: 'secret-2',
      };

      await getOidcConfiguration(config1);
      await getOidcConfiguration(config2);

      expect(openidClient.discovery).toHaveBeenCalledTimes(2);
    });

    it('should construct issuer URL for org-level auth server (no /oauth2/ path)', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://org-level.okta.com',
        clientId: 'org-client',
        clientSecret: 'org-secret',
        useOrgAuthServer: true,
      };

      await getOidcConfiguration(oktaConfig);

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://org-level.okta.com/',
        }),
        'org-client',
        expect.anything(),
        expect.anything()
      );
    });

    it('should use separate cache entries for org-level vs custom auth server', async () => {
      const orgConfig: OktaConfig = {
        audience: 'https://same-domain.okta.com',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        useOrgAuthServer: true,
      };

      const customConfig: OktaConfig = {
        audience: 'https://same-domain.okta.com',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        useOrgAuthServer: false,
      };

      await getOidcConfiguration(orgConfig);
      await getOidcConfiguration(customConfig);

      // Should make two separate discovery calls even for same audience/client
      expect(openidClient.discovery).toHaveBeenCalledTimes(2);
    });

    it('should handle whitespace-only authServerId by using default', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://example.okta.com',
        clientId: 'client-123',
        clientSecret: 'secret-123',
        authServerId: '   ',
        useOrgAuthServer: false,
      };

      await getOidcConfiguration(oktaConfig);

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.okta.com/oauth2/default',
        }),
        'client-123',
        expect.anything(),
        expect.anything()
      );
    });

    it('should clear cache when clearConfigurationCache is called', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://clear-test.okta.com',
        clientId: 'clear-client',
        clientSecret: 'clear-secret',
      };

      await getOidcConfiguration(oktaConfig);
      expect(openidClient.discovery).toHaveBeenCalledTimes(1);

      clearConfigurationCache();

      await getOidcConfiguration(oktaConfig);
      expect(openidClient.discovery).toHaveBeenCalledTimes(2);
    });

    it('should throw error for non-HTTPS audience URL', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'http://insecure.okta.com',
        clientId: 'client-123',
        clientSecret: 'secret-123',
      };

      await expect(getOidcConfiguration(oktaConfig)).rejects.toThrow('Okta audience must be an HTTPS URL');
    });

    it('should throw error for invalid authServerId format', async () => {
      const oktaConfig: OktaConfig = {
        audience: 'https://example.okta.com',
        clientId: 'client-123',
        clientSecret: 'secret-123',
        authServerId: '../malicious',
        useOrgAuthServer: false,
      };

      await expect(getOidcConfiguration(oktaConfig)).rejects.toThrow('Invalid authorization server ID format');
    });

    describe('org-level fallback on custom auth server failure', () => {
      const customOnlyConfig: OktaConfig = {
        audience: 'https://fallback-test.okta.com',
        clientId: 'fallback-client',
        clientSecret: 'fallback-secret',
        authServerId: 'default',
        useOrgAuthServer: false,
      };

      // Shape-matches what openid-client throws when discovery hits a non-2xx:
      // ClientError with code 'OAUTH_RESPONSE_IS_NOT_CONFORM' and cause set
      // to the original fetch Response. The narrowing helper checks for
      // exactly this shape.
      const misconfigError = (status: number) =>
        new openidClient.ClientError('unexpected HTTP response status code', {
          code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
          cause: new Response(null, { status }),
        });

      it('retries discovery against the org-level auth server when custom discovery returns 404', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        const result = await getOidcConfiguration(customOnlyConfig);

        expect(result).toBe(mockConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);
        // First call: custom auth server URL
        expect(openidClient.discovery).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ href: 'https://fallback-test.okta.com/oauth2/default' }),
          'fallback-client',
          expect.anything(),
          expect.anything()
        );
        // Second call (fallback): org-level URL - no /oauth2/ path
        expect(openidClient.discovery).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ href: 'https://fallback-test.okta.com/' }),
          'fallback-client',
          expect.anything(),
          expect.anything()
        );
      });

      it('caches fallback result under the org-level key, not the custom-server key', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        // First call triggers primary failure + fallback success
        await getOidcConfiguration(customOnlyConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);

        // Explicit org-level lookup hits the cached fallback result - proving
        // the fallback config was stored under the org-level key.
        const orgConfig: OktaConfig = { ...customOnlyConfig, useOrgAuthServer: true };
        await getOidcConfiguration(orgConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);
      });

      it('demotes an SST-sourced audience to org-level so it skips custom discovery on the next call', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        // First call: custom discovery fails (1) -> org-level fallback succeeds (2)
        await getOidcConfiguration(customOnlyConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);

        // Second call with the SAME (unpersisted, SST-shaped) config: the audience
        // is now demoted, so it goes straight to org-level and hits the org cache
        // entry - no failed custom discovery, no further fallback, no extra calls.
        // This is the fix for the per-cache-miss recurrence.
        await getOidcConfiguration(customOnlyConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);
      });

      it('re-discovers via org-level (not custom) for a demoted audience after the cache expires', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        await getOidcConfiguration(customOnlyConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);

        // Simulate cache expiry: clearing only the config cache would also clear
        // the demotion, so instead advance time past the TTL via fake timers.
        // try/finally so a failed assertion can't leak fake timers into the
        // rest of the suite (which would cascade confusing failures).
        vi.useFakeTimers();
        try {
          vi.advanceTimersByTime(3_600_000); // 1h — beyond any TTL bound
          vi.mocked(openidClient.discovery).mockResolvedValueOnce(mockConfig as any);

          await getOidcConfiguration(customOnlyConfig);

          // One additional discovery, and it targets the ORG-LEVEL URL (no /oauth2/),
          // not the custom auth server that we already know 404s.
          expect(openidClient.discovery).toHaveBeenCalledTimes(3);
          expect(openidClient.discovery).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({ href: 'https://fallback-test.okta.com/' }),
            'fallback-client',
            expect.anything(),
            expect.anything()
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('demotion does not leak across audiences (different clientId still tries custom first)', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);
        await getOidcConfiguration(customOnlyConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);

        // A different audience/clientId is NOT demoted - it must attempt custom
        // discovery first (call 3), then fall back (call 4).
        const otherConfig: OktaConfig = {
          audience: 'https://other-tenant.okta.com',
          clientId: 'other-client',
          clientSecret: 'other-secret',
          authServerId: 'default',
          useOrgAuthServer: false,
        };
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);
        await getOidcConfiguration(otherConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(4);
        expect(openidClient.discovery).toHaveBeenNthCalledWith(
          3,
          expect.objectContaining({ href: 'https://other-tenant.okta.com/oauth2/default' }),
          'other-client',
          expect.anything(),
          expect.anything()
        );
      });

      it('shares demotion/cache state across trailing-slash audience variants', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        // First call demotes `https://fallback-test.okta.com` (no trailing slash).
        await getOidcConfiguration(customOnlyConfig);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);

        // A semantically-identical audience with a trailing slash must hit the
        // same demotion + org cache entry - NO extra discovery - because keys are
        // normalized the same way getIssuerUrl() normalizes the discovery URL.
        const slashVariant: OktaConfig = { ...customOnlyConfig, audience: 'https://fallback-test.okta.com/' };
        await getOidcConfiguration(slashVariant);
        expect(openidClient.discovery).toHaveBeenCalledTimes(2);
      });

      it('persists useOrgAuthServer=true to the IDP record on successful fallback', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);
        vi.mocked(identityProviderRepository.updateIDP).mockResolvedValue({} as any);

        const idp = {
          id: 'idp-misconfigured',
          oktaConfig: {
            audience: 'https://fallback-test.okta.com',
            clientId: 'fallback-client',
            clientSecret: 'fallback-secret',
            authServerId: 'default',
            useOrgAuthServer: false,
          },
        } as any;

        await getOidcConfiguration(customOnlyConfig, idp);

        expect(identityProviderRepository.updateIDP).toHaveBeenCalledWith('idp-misconfigured', {
          oktaConfig: {
            audience: 'https://fallback-test.okta.com',
            clientId: 'fallback-client',
            clientSecret: 'fallback-secret',
            authServerId: 'default',
            useOrgAuthServer: true,
          },
        });
      });

      it('still returns the config when auto-correction persistence fails', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);
        vi.mocked(identityProviderRepository.updateIDP).mockRejectedValue(new Error('db write failed'));

        const idp = {
          id: 'idp-misconfigured',
          oktaConfig: {
            audience: 'https://fallback-test.okta.com',
            clientId: 'fallback-client',
            clientSecret: 'fallback-secret',
          },
        } as any;

        const result = await getOidcConfiguration(customOnlyConfig, idp);
        expect(result).toBe(mockConfig);
      });

      it('does not call updateIDP for SST-sourced config (no idp document)', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        await getOidcConfiguration(customOnlyConfig);

        expect(identityProviderRepository.updateIDP).not.toHaveBeenCalled();
      });

      it('does not call updateIDP when idp document has no oktaConfig field', async () => {
        vi.mocked(openidClient.discovery)
          .mockRejectedValueOnce(misconfigError(404))
          .mockResolvedValueOnce(mockConfig as any);

        const idp = { id: 'idp-broken' } as any;

        const result = await getOidcConfiguration(customOnlyConfig, idp);
        expect(result).toBe(mockConfig);
        expect(identityProviderRepository.updateIDP).not.toHaveBeenCalled();
      });

      it('does NOT fall back when useOrgAuthServer is already true (preserves loud failure for real outages)', async () => {
        const orgError = misconfigError(404);
        vi.mocked(openidClient.discovery).mockRejectedValueOnce(orgError);

        const orgConfig: OktaConfig = { ...customOnlyConfig, useOrgAuthServer: true };
        await expect(getOidcConfiguration(orgConfig)).rejects.toBe(orgError);
        expect(openidClient.discovery).toHaveBeenCalledTimes(1);
      });

      it('does NOT fall back on a 5xx (Okta-side outage — must surface loudly, not mis-correct)', async () => {
        const outageError = misconfigError(503);
        vi.mocked(openidClient.discovery).mockRejectedValueOnce(outageError);

        await expect(getOidcConfiguration(customOnlyConfig)).rejects.toBe(outageError);
        expect(openidClient.discovery).toHaveBeenCalledTimes(1);
        expect(identityProviderRepository.updateIDP).not.toHaveBeenCalled();
      });

      it('does NOT fall back on a non-HTTP error (e.g. network failure)', async () => {
        const networkError = new TypeError('fetch failed');
        vi.mocked(openidClient.discovery).mockRejectedValueOnce(networkError);

        await expect(getOidcConfiguration(customOnlyConfig)).rejects.toBe(networkError);
        expect(openidClient.discovery).toHaveBeenCalledTimes(1);
      });

      it('throws AggregateError preserving both errors when fallback also fails', async () => {
        const primaryError = misconfigError(404);
        const fallbackError = new Error('fallback discovery failed');
        vi.mocked(openidClient.discovery).mockRejectedValueOnce(primaryError).mockRejectedValueOnce(fallbackError);

        await expect(getOidcConfiguration(customOnlyConfig)).rejects.toMatchObject({
          name: 'AggregateError',
          errors: [primaryError, fallbackError],
        });
      });
    });

    it('should allow valid authServerId formats', async () => {
      const validAuthServerIds = ['default', 'aus123abc', 'my-auth-server', 'my_auth_server', 'Auth123'];

      for (const authServerId of validAuthServerIds) {
        clearConfigurationCache();
        const oktaConfig: OktaConfig = {
          audience: 'https://example.okta.com',
          clientId: 'client-123',
          clientSecret: 'secret-123',
          authServerId,
          useOrgAuthServer: false,
        };

        await getOidcConfiguration(oktaConfig);
        expect(openidClient.discovery).toHaveBeenCalledWith(
          expect.objectContaining({
            href: `https://example.okta.com/oauth2/${authServerId}`,
          }),
          expect.anything(),
          expect.anything(),
          expect.anything()
        );
      }
    });
  });

  describe('extractOktaConfigFromIdp', () => {
    it('should return OktaConfig when IDP has valid oktaConfig', () => {
      const mockIdp = {
        id: 'idp-123',
        type: 'okta',
        oktaConfig: {
          audience: 'https://test.okta.com',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          authServerId: 'custom-server',
        },
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);

      expect(result).toEqual({
        audience: 'https://test.okta.com',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        authServerId: 'custom-server',
        useOrgAuthServer: false,
      });
    });

    it('should extract useOrgAuthServer when set to true', () => {
      const mockIdp = {
        id: 'idp-org',
        type: 'okta',
        oktaConfig: {
          audience: 'https://org.okta.com',
          clientId: 'org-client-id',
          clientSecret: 'org-client-secret',
          useOrgAuthServer: true,
        },
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);

      expect(result).toEqual({
        audience: 'https://org.okta.com',
        clientId: 'org-client-id',
        clientSecret: 'org-client-secret',
        authServerId: 'default',
        useOrgAuthServer: true,
      });
    });

    it('should default authServerId to "default" and useOrgAuthServer to false when not provided', () => {
      const mockIdp = {
        id: 'idp-123',
        type: 'okta',
        oktaConfig: {
          audience: 'https://test.okta.com',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
        },
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);

      expect(result?.authServerId).toBe('default');
      expect(result?.useOrgAuthServer).toBe(false);
    });

    it('should return null when IDP is null', () => {
      const result = extractOktaConfigFromIdp(null);
      expect(result).toBeNull();
    });

    it('should return null when IDP is undefined', () => {
      const result = extractOktaConfigFromIdp(undefined);
      expect(result).toBeNull();
    });

    it('should return null when oktaConfig is missing', () => {
      const mockIdp = {
        id: 'idp-123',
        type: 'okta',
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);
      expect(result).toBeNull();
    });

    it('should return null when audience is missing', () => {
      const mockIdp = {
        id: 'idp-123',
        type: 'okta',
        oktaConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
        },
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);
      expect(result).toBeNull();
    });

    it('should return null when clientId is missing', () => {
      const mockIdp = {
        id: 'idp-123',
        type: 'okta',
        oktaConfig: {
          audience: 'https://test.okta.com',
          clientSecret: 'test-client-secret',
        },
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);
      expect(result).toBeNull();
    });

    it('should return null when clientSecret is missing', () => {
      const mockIdp = {
        id: 'idp-123',
        type: 'okta',
        oktaConfig: {
          audience: 'https://test.okta.com',
          clientId: 'test-client-id',
        },
      };

      const result = extractOktaConfigFromIdp(mockIdp as any);
      expect(result).toBeNull();
    });
  });

  describe('getOktaConfigStatus', () => {
    describe('with database IDP config', () => {
      it('should return database as effectiveSource when active Okta IDP exists', async () => {
        const mockIdps = [
          {
            id: 'idp-123',
            type: 'okta',
            isActive: true,
            oktaConfig: {
              audience: 'https://db.okta.com',
              clientId: 'db-client-id',
              clientSecret: 'db-client-secret',
              authServerId: 'custom-auth',
            },
          },
        ];
        vi.mocked(identityProviderRepository.findAll).mockResolvedValue(mockIdps as any);

        const result = await getOktaConfigStatus();

        expect(result.sstConfigured).toBe(true); // SST is also configured per mock
        expect(result.databaseConfigured).toBe(true);
        expect(result.effectiveSource).toBe('database');
        expect(result.effectiveConfig).toEqual({
          audience: 'https://db.okta.com',
          clientId: 'db-client-id',
          clientSecret: 'db-client-secret',
          authServerId: 'custom-auth',
          useOrgAuthServer: false,
        });
      });

      it('should skip inactive Okta IDPs', async () => {
        const mockIdps = [
          {
            id: 'idp-123',
            type: 'okta',
            isActive: false,
            oktaConfig: {
              audience: 'https://db.okta.com',
              clientId: 'db-client-id',
              clientSecret: 'db-client-secret',
            },
          },
        ];
        vi.mocked(identityProviderRepository.findAll).mockResolvedValue(mockIdps as any);

        const result = await getOktaConfigStatus();

        expect(result.databaseConfigured).toBe(false);
        expect(result.effectiveSource).toBe('sst'); // Falls back to SST
      });

      it('should skip non-Okta IDPs', async () => {
        const mockIdps = [
          {
            id: 'idp-123',
            type: 'saml',
            isActive: true,
          },
        ];
        vi.mocked(identityProviderRepository.findAll).mockResolvedValue(mockIdps as any);

        const result = await getOktaConfigStatus();

        expect(result.databaseConfigured).toBe(false);
        expect(result.effectiveSource).toBe('sst');
      });
    });

    describe('with SST config only', () => {
      it('should return sst as effectiveSource when no database IDP exists', async () => {
        vi.mocked(identityProviderRepository.findAll).mockResolvedValue([]);

        const result = await getOktaConfigStatus();

        expect(result.sstConfigured).toBe(true);
        expect(result.databaseConfigured).toBe(false);
        expect(result.effectiveSource).toBe('sst');
        expect(result.effectiveConfig).toEqual({
          audience: 'https://test.okta.com',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          authServerId: 'default',
          useOrgAuthServer: false,
        });
      });

      it('should reflect OKTA_USE_ORG_AUTH_SERVER in the SST effectiveConfig', async () => {
        // getOktaConfigStatus drives the system-health / test-oauth call sites, so the
        // org-level flag must flow through here too - not just getOktaConfigWithFallback.
        vi.mocked(identityProviderRepository.findAll).mockResolvedValue([]);
        (Config as { OKTA_USE_ORG_AUTH_SERVER?: string }).OKTA_USE_ORG_AUTH_SERVER = 'true';
        try {
          const result = await getOktaConfigStatus();
          expect(result.effectiveSource).toBe('sst');
          expect(result.effectiveConfig).toEqual({
            audience: 'https://test.okta.com',
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            authServerId: undefined,
            useOrgAuthServer: true,
          });
        } finally {
          delete (Config as { OKTA_USE_ORG_AUTH_SERVER?: string }).OKTA_USE_ORG_AUTH_SERVER;
        }
      });
    });

    describe('error handling', () => {
      it('should fallback to SST when database throws error', async () => {
        vi.mocked(identityProviderRepository.findAll).mockRejectedValue(new Error('Database error'));

        const result = await getOktaConfigStatus();

        expect(result.databaseConfigured).toBe(false);
        expect(result.effectiveSource).toBe('sst');
        expect(result.effectiveConfig?.clientId).toBe('test-client-id');
      });
    });
  });

  describe('buildAuthorizationUrl', () => {
    const mockConfig = { serverMetadata: vi.fn() };

    beforeEach(() => {
      vi.mocked(openidClient.discovery).mockResolvedValue(mockConfig as any);
    });

    it('should build authorization URL for org-level auth server', async () => {
      const mockAuthUrl = new URL('https://org.okta.com/oauth2/v1/authorize?client_id=org-client');
      vi.mocked(openidClient.buildAuthorizationUrl).mockReturnValue(mockAuthUrl);

      const oktaConfig: OktaConfig = {
        audience: 'https://org.okta.com',
        clientId: 'org-client',
        clientSecret: 'org-secret',
        useOrgAuthServer: true,
      };

      const result = await buildAuthorizationUrl(
        oktaConfig,
        'https://callback.example.com/auth/okta/callback',
        { codeVerifier: 'test-verifier', codeChallenge: 'test-challenge' },
        'state-token-123'
      );

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://org.okta.com/' }),
        'org-client',
        expect.anything(),
        expect.anything()
      );

      expect(openidClient.buildAuthorizationUrl).toHaveBeenCalledWith(mockConfig, {
        redirect_uri: 'https://callback.example.com/auth/okta/callback',
        scope: 'openid profile email',
        state: 'state-token-123',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      expect(result).toEqual(mockAuthUrl);
    });

    it('should build authorization URL for custom auth server', async () => {
      const mockAuthUrl = new URL('https://custom.okta.com/oauth2/custom-server/v1/authorize');
      vi.mocked(openidClient.buildAuthorizationUrl).mockReturnValue(mockAuthUrl);

      const oktaConfig: OktaConfig = {
        audience: 'https://custom.okta.com',
        clientId: 'custom-client',
        clientSecret: 'custom-secret',
        authServerId: 'custom-server',
        useOrgAuthServer: false,
      };

      await buildAuthorizationUrl(
        oktaConfig,
        'https://callback.example.com',
        { codeVerifier: 'verifier', codeChallenge: 'challenge' },
        'state'
      );

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://custom.okta.com/oauth2/custom-server' }),
        'custom-client',
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe('exchangeCodeForTokens', () => {
    const mockConfig = { serverMetadata: vi.fn() };

    beforeEach(() => {
      vi.mocked(openidClient.discovery).mockResolvedValue(mockConfig as any);
    });

    it('should exchange code for tokens using org-level auth server', async () => {
      const mockTokenResponse = {
        access_token: 'access-token-123',
        id_token: 'id-token-123',
        refresh_token: 'refresh-token-123',
      };
      vi.mocked(openidClient.authorizationCodeGrant).mockResolvedValue(mockTokenResponse as any);

      const oktaConfig: OktaConfig = {
        audience: 'https://org.okta.com',
        clientId: 'org-client',
        clientSecret: 'org-secret',
        useOrgAuthServer: true,
      };

      const result = await exchangeCodeForTokens(
        oktaConfig,
        new URL('https://callback.example.com?code=auth-code-123&state=state-token'),
        'code-verifier-123',
        'state-token'
      );

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://org.okta.com/' }),
        'org-client',
        expect.anything(),
        expect.anything()
      );

      expect(openidClient.authorizationCodeGrant).toHaveBeenCalledWith(mockConfig, expect.any(URL), {
        expectedState: 'state-token',
        pkceCodeVerifier: 'code-verifier-123',
      });

      expect(result.accessToken).toBe('access-token-123');
      expect(result.idToken).toBe('id-token-123');
      expect(result.refreshToken).toBe('refresh-token-123');
    });
  });

  describe('fetchUserInfo', () => {
    const mockConfig = { serverMetadata: vi.fn() };

    beforeEach(() => {
      vi.mocked(openidClient.discovery).mockResolvedValue(mockConfig as any);
    });

    it('should fetch user info using org-level auth server', async () => {
      const mockUserInfo = {
        sub: 'user-123',
        email: 'user@example.com',
        email_verified: true,
        name: 'Test User',
        given_name: 'Test',
        family_name: 'User',
      };
      vi.mocked(openidClient.fetchUserInfo).mockResolvedValue(mockUserInfo as any);

      const oktaConfig: OktaConfig = {
        audience: 'https://org.okta.com',
        clientId: 'org-client',
        clientSecret: 'org-secret',
        useOrgAuthServer: true,
      };

      const result = await fetchUserInfo(oktaConfig, 'access-token-123', 'user-123');

      expect(openidClient.discovery).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://org.okta.com/' }),
        'org-client',
        expect.anything(),
        expect.anything()
      );

      expect(openidClient.fetchUserInfo).toHaveBeenCalledWith(mockConfig, 'access-token-123', 'user-123');

      expect(result.sub).toBe('user-123');
      expect(result.email).toBe('user@example.com');
      expect(result.name).toBe('Test User');
    });
  });
});
