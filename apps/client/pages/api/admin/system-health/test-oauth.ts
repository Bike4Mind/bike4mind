import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { Config } from '@server/utils/config';
import { getOktaConfigStatus } from '@server/auth/oktaOidcClient';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

export type OAuthProvider = 'okta' | 'google' | 'github';

/** Detailed diagnostics for OIDC endpoints */
export interface OktaDiagnostics {
  /** JWKS endpoint validation */
  jwks?: {
    reachable: boolean;
    keyCount: number;
    error?: string;
  };
  /** Token endpoint reachability test */
  tokenEndpoint?: {
    reachable: boolean;
    status: number;
    acceptsClientAuth: boolean;
    error?: string;
  };
  /** Userinfo endpoint reachability test */
  userinfoEndpoint?: {
    reachable: boolean;
    status: number;
    error?: string;
  };
  /** Whether issuer in discovery matches expected URL */
  issuerMatch?: boolean;
  /** Expected issuer URL */
  expectedIssuer?: string;
  /** Actual issuer from discovery */
  actualIssuer?: string;
  /** Signing algorithms supported */
  signingAlgorithms?: string[];
  /** Whether RS256 is supported (required for most flows) */
  supportsRS256?: boolean;
  /** Required SST secrets that are missing (these are always required regardless of config source) */
  missingSstSecrets?: string[];
}

export interface TestOAuthResult {
  success: boolean;
  provider: OAuthProvider;
  latencyMs?: number;
  error?: string;
  details?: {
    endpoint?: string;
    status?: number;
    /** For Okta: which config source was used (database or sst) */
    configSource?: 'database' | 'sst' | 'none';
    /** Detailed Okta diagnostics (only present for Okta provider) */
    diagnostics?: OktaDiagnostics;
  };
  timestamp: string;
}

const inputSchema = z.object({
  provider: z.enum(['okta', 'google', 'github']),
});

/**
 * Test OAuth provider connectivity by checking their discovery/authorization endpoints.
 * This verifies that:
 * 1. The required secrets are configured
 * 2. The provider endpoint is reachable
 * 3. The configuration is valid (e.g., Okta audience URL is correct)
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000, // 5 attempts per minute
    })
  )
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const parseResult = inputSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError('Invalid provider. Must be one of: okta, google, github');
    }

    const { provider } = parseResult.data;
    const startTime = Date.now();

    try {
      let testResult: { success: boolean; endpoint: string; status?: number; error?: string };

      switch (provider) {
        case 'okta':
          testResult = await testOktaConnectivity();
          break;
        case 'google':
          testResult = await testGoogleConnectivity();
          break;
        case 'github':
          testResult = await testGitHubConnectivity();
          break;
        default:
          throw new BadRequestError(`Unknown provider: ${provider}`);
      }

      const latencyMs = Date.now() - startTime;

      await logAuditEvent(
        {
          userId: req.user!.id,
          action: AdminConfigAuditEvents.ADMIN_OAUTH_TEST,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
          metadata: { provider, success: testResult.success },
        },
        req.logger
      );

      // Build details object, including configSource and diagnostics for Okta tests
      const details: TestOAuthResult['details'] = {
        endpoint: testResult.endpoint,
        ...(testResult.status && { status: testResult.status }),
      };

      // Add configSource for Okta (returned from testOktaConnectivity)
      if ('configSource' in testResult && testResult.configSource) {
        details.configSource = testResult.configSource as 'database' | 'sst' | 'none';
      }

      // Add diagnostics for Okta (returned from testOktaConnectivity)
      if ('diagnostics' in testResult && testResult.diagnostics) {
        details.diagnostics = testResult.diagnostics as OktaDiagnostics;
      }

      const result: TestOAuthResult = {
        success: testResult.success,
        provider,
        latencyMs,
        timestamp: new Date().toISOString(),
        ...(testResult.error && { error: testResult.error }),
        details,
      };

      return res.json(result);
    } catch (error) {
      req.logger.error(`Error testing ${provider} OAuth:`, error);
      const latencyMs = Date.now() - startTime;

      return res.status(500).json({
        success: false,
        provider,
        latencyMs,
        error: error instanceof Error ? error.message : 'Failed to test OAuth provider',
        timestamp: new Date().toISOString(),
      });
    }
  });

/**
 * Test JWKS endpoint and validate it has signing keys
 */
async function testJwksEndpoint(jwksUri: string): Promise<OktaDiagnostics['jwks']> {
  try {
    const response = await axios.get(jwksUri, { timeout: 10000 });
    const keys = response.data?.keys;

    if (!Array.isArray(keys)) {
      return { reachable: true, keyCount: 0, error: 'JWKS response missing keys array' };
    }

    if (keys.length === 0) {
      return { reachable: true, keyCount: 0, error: 'JWKS has no signing keys - token validation will fail' };
    }

    // Validate at least one key has required fields
    const validKeys = keys.filter((k: Record<string, unknown>) => k.kid && k.kty && (k.alg || k.use === 'sig'));
    if (validKeys.length === 0) {
      return {
        reachable: true,
        keyCount: keys.length,
        error: 'JWKS keys missing required fields (kid, kty, alg)',
      };
    }

    return { reachable: true, keyCount: keys.length };
  } catch (error) {
    const message = error instanceof AxiosError ? error.message : 'Failed to reach JWKS endpoint';
    return { reachable: false, keyCount: 0, error: message };
  }
}

/**
 * Test token endpoint reachability by sending a minimal request
 * Expected: 400/401 (invalid request), not 404/500 (misconfiguration)
 */
async function testTokenEndpoint(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string
): Promise<OktaDiagnostics['tokenEndpoint']> {
  try {
    const response = await axios.post(
      tokenEndpoint,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'invalid_test_code',
        redirect_uri: 'https://test.invalid/callback',
      }).toString(),
      {
        timeout: 10000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: { username: clientId, password: clientSecret },
        validateStatus: () => true, // Don't throw on any status
      }
    );

    const status = response.status;

    // 400/401 = expected (invalid code/request), endpoint works
    // 404/500+ = misconfiguration
    if (status === 404) {
      return {
        reachable: false,
        status,
        acceptsClientAuth: false,
        error: 'Token endpoint not found (404)',
      };
    }
    if (status >= 500) {
      return {
        reachable: false,
        status,
        acceptsClientAuth: false,
        error: `Token endpoint server error (${status})`,
      };
    }

    // 401 with WWW-Authenticate might indicate client auth failure
    const acceptsClientAuth = status !== 401 || !response.headers['www-authenticate']?.includes('invalid_client');

    return { reachable: true, status, acceptsClientAuth };
  } catch (error) {
    const message = error instanceof AxiosError ? error.message : 'Failed to reach token endpoint';
    return {
      reachable: false,
      status: 0,
      acceptsClientAuth: false,
      error: message,
    };
  }
}

/**
 * Test userinfo endpoint reachability
 * Expected: 401 (no token), not 404/500 (misconfiguration)
 */
async function testUserinfoEndpoint(userinfoEndpoint: string): Promise<OktaDiagnostics['userinfoEndpoint']> {
  try {
    const response = await axios.get(userinfoEndpoint, {
      timeout: 10000,
      headers: { Authorization: 'Bearer invalid_test_token' },
      validateStatus: () => true, // Don't throw on any status
    });

    const status = response.status;

    if (status === 404) {
      return { reachable: false, status, error: 'Userinfo endpoint not found (404)' };
    }
    if (status >= 500) {
      return { reachable: false, status, error: `Userinfo endpoint server error (${status})` };
    }

    // 401 = expected (invalid token), endpoint works
    return { reachable: true, status };
  } catch (error) {
    const message = error instanceof AxiosError ? error.message : 'Failed to reach userinfo endpoint';
    return { reachable: false, status: 0, error: message };
  }
}

/**
 * Test Okta connectivity by fetching the OpenID Connect discovery document
 * and running additional diagnostic checks.
 * Uses the effective config (database IDP takes precedence over SST secrets).
 */
async function testOktaConnectivity(): Promise<{
  success: boolean;
  endpoint: string;
  status?: number;
  error?: string;
  configSource?: 'database' | 'sst' | 'none';
  diagnostics?: OktaDiagnostics;
}> {
  // Get the effective config (database takes precedence over SST).
  // SECRET_ENCRYPTION_KEY and JWT_SECRET validation happens in system-health.ts; the
  // "Test Okta" button is disabled when Okta shows "Missing", so no re-check here.
  const { effectiveConfig, effectiveSource } = await getOktaConfigStatus();

  // Check if any config is available
  if (!effectiveConfig) {
    return {
      success: false,
      endpoint: 'N/A',
      error: 'No Okta configuration available (neither database IDP nor SST secrets are configured)',
      configSource: 'none',
    };
  }

  const { audience, clientId, clientSecret } = effectiveConfig;

  // Validate required fields (should always be present if effectiveConfig exists, but double-check)
  if (!audience || !clientId || !clientSecret) {
    const missing = [];
    if (!audience) missing.push('audience');
    if (!clientId) missing.push('clientId');
    if (!clientSecret) missing.push('clientSecret');
    return {
      success: false,
      endpoint: 'N/A',
      error: `Incomplete ${effectiveSource} configuration: missing ${missing.join(', ')}`,
      configSource: effectiveSource,
    };
  }

  // Normalize the audience URL (remove trailing slashes)
  const normalizedAudience = audience.replace(/\/+$/, '');

  // Build discovery endpoint URL based on authorization server type
  const useOrgAuthServer = effectiveConfig.useOrgAuthServer ?? false;
  let endpoint: string;
  let expectedIssuer: string;
  if (useOrgAuthServer) {
    // Org-level authorization server: discovery at base domain
    endpoint = `${normalizedAudience}/.well-known/openid-configuration`;
    expectedIssuer = normalizedAudience;
  } else {
    // Custom authorization server: discovery at /oauth2/{authServerId}
    const authServerId = effectiveConfig.authServerId?.trim() || 'default';
    endpoint = `${normalizedAudience}/oauth2/${authServerId}/.well-known/openid-configuration`;
    expectedIssuer = `${normalizedAudience}/oauth2/${authServerId}`;
  }

  try {
    const response = await axios.get(endpoint, { timeout: 10000 });

    if (response.status !== 200) {
      return {
        success: false,
        endpoint,
        status: response.status,
        error: `Unexpected status code: ${response.status}`,
        configSource: effectiveSource,
      };
    }

    // Validate required OIDC fields are present in discovery response
    // These fields are required for the login flow to work correctly
    const discoveryData = response.data;
    const requiredFields = ['userinfo_endpoint', 'authorization_endpoint', 'token_endpoint'];
    const missingFields = requiredFields.filter(field => !discoveryData[field]);

    if (missingFields.length > 0) {
      const serverType = useOrgAuthServer ? 'Org-level' : 'Custom';
      return {
        success: false,
        endpoint,
        status: response.status,
        error: `${serverType} authorization server discovery is missing required OIDC fields: ${missingFields.join(', ')}. Login will fail without these endpoints. Check your Okta authorization server configuration or try disabling "Use Org-Level Authorization Server" if your Okta license doesn't support it.`,
        configSource: effectiveSource,
      };
    }

    // Build diagnostics object
    const diagnostics: OktaDiagnostics = {};

    // Check issuer match
    const actualIssuer = discoveryData.issuer;
    diagnostics.actualIssuer = actualIssuer;
    diagnostics.expectedIssuer = expectedIssuer;
    diagnostics.issuerMatch = actualIssuer === expectedIssuer;

    // Check signing algorithms
    const signingAlgs = discoveryData.id_token_signing_alg_values_supported;
    if (Array.isArray(signingAlgs)) {
      diagnostics.signingAlgorithms = signingAlgs;
      diagnostics.supportsRS256 = signingAlgs.includes('RS256');
    }

    // Test JWKS endpoint
    if (discoveryData.jwks_uri) {
      diagnostics.jwks = await testJwksEndpoint(discoveryData.jwks_uri);
    } else {
      diagnostics.jwks = { reachable: false, keyCount: 0, error: 'No jwks_uri in discovery document' };
    }

    // Test token endpoint reachability
    diagnostics.tokenEndpoint = await testTokenEndpoint(discoveryData.token_endpoint, clientId, clientSecret);

    // Test userinfo endpoint reachability
    diagnostics.userinfoEndpoint = await testUserinfoEndpoint(discoveryData.userinfo_endpoint);

    // Determine overall success - discovery passed, but warn about diagnostic issues
    const hasWarnings =
      !diagnostics.issuerMatch ||
      !diagnostics.supportsRS256 ||
      !diagnostics.jwks?.reachable ||
      diagnostics.jwks?.keyCount === 0 ||
      !diagnostics.tokenEndpoint?.reachable ||
      !diagnostics.tokenEndpoint?.acceptsClientAuth ||
      !diagnostics.userinfoEndpoint?.reachable;

    // Build warning message if there are issues
    let warningMessage: string | undefined;
    if (hasWarnings) {
      const warnings: string[] = [];
      if (!diagnostics.issuerMatch) {
        warnings.push(`Issuer mismatch (expected: ${expectedIssuer}, got: ${actualIssuer})`);
      }
      if (!diagnostics.supportsRS256) {
        warnings.push('RS256 signing not supported');
      }
      if (!diagnostics.jwks?.reachable) {
        warnings.push(`JWKS: ${diagnostics.jwks?.error || 'unreachable'}`);
      } else if (diagnostics.jwks?.keyCount === 0) {
        warnings.push('JWKS has no keys');
      }
      if (!diagnostics.tokenEndpoint?.reachable) {
        warnings.push(`Token endpoint: ${diagnostics.tokenEndpoint?.error || 'unreachable'}`);
      } else if (!diagnostics.tokenEndpoint?.acceptsClientAuth) {
        warnings.push('Token endpoint may reject client credentials');
      }
      if (!diagnostics.userinfoEndpoint?.reachable) {
        warnings.push(`Userinfo endpoint: ${diagnostics.userinfoEndpoint?.error || 'unreachable'}`);
      }
      if (warnings.length > 0) {
        warningMessage = `Discovery passed but with warnings: ${warnings.join('; ')}`;
      }
    }

    return {
      success: true,
      endpoint,
      status: response.status,
      configSource: effectiveSource,
      diagnostics,
      ...(warningMessage && { error: warningMessage }),
    };
  } catch (error) {
    const axiosError = error as { response?: { status: number }; message?: string };
    const status = axiosError.response?.status;

    // Provide specific guidance based on error type
    const sourceLabel = effectiveSource === 'database' ? 'Database IDP' : 'SST';
    let errorMessage = axiosError.message || 'Failed to reach Okta';
    if (status === 404) {
      errorMessage = `Okta discovery endpoint returned 404. This usually means the ${sourceLabel} audience URL is incorrect. Expected format: https://your-domain.okta.com (current value resolves to: ${endpoint})`;
    }

    return {
      success: false,
      endpoint,
      status,
      error: errorMessage,
      configSource: effectiveSource,
    };
  }
}

/**
 * Test Google OAuth connectivity by fetching the OpenID Connect discovery document
 */
async function testGoogleConnectivity(): Promise<{
  success: boolean;
  endpoint: string;
  status?: number;
  error?: string;
}> {
  const clientId = Config.GOOGLE_CLIENT_ID;
  const clientSecret = Config.GOOGLE_CLIENT_SECRET;

  // Check if secrets are configured
  if (!clientId || !clientSecret) {
    const missing = [];
    if (!clientId) missing.push('GOOGLE_CLIENT_ID');
    if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
    return {
      success: false,
      endpoint: 'N/A',
      error: `Missing configuration: ${missing.join(', ')}`,
    };
  }

  // Fetch Google's OIDC discovery document
  const endpoint = 'https://accounts.google.com/.well-known/openid-configuration';

  try {
    const response = await axios.get(endpoint, { timeout: 10000 });
    return {
      success: response.status === 200,
      endpoint,
      status: response.status,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    return {
      success: false,
      endpoint,
      status: axiosError.response?.status,
      error: axiosError.message || 'Failed to reach Google',
    };
  }
}

/**
 * Test GitHub OAuth connectivity by checking the authorize endpoint
 */
async function testGitHubConnectivity(): Promise<{
  success: boolean;
  endpoint: string;
  status?: number;
  error?: string;
}> {
  const clientId = Config.GITHUB_CLIENT_ID;
  const clientSecret = Config.GITHUB_CLIENT_SECRET;

  // Check if secrets are configured
  if (!clientId || !clientSecret) {
    const missing = [];
    if (!clientId) missing.push('GITHUB_CLIENT_ID');
    if (!clientSecret) missing.push('GITHUB_CLIENT_SECRET');
    return {
      success: false,
      endpoint: 'N/A',
      error: `Missing configuration: ${missing.join(', ')}`,
    };
  }

  // Test GitHub API endpoint (doesn't require auth)
  const endpoint = 'https://api.github.com';

  try {
    const response = await axios.get(endpoint, {
      timeout: 10000,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'B4M-Health-Check',
      },
    });
    return {
      success: response.status === 200,
      endpoint,
      status: response.status,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    return {
      success: false,
      endpoint,
      status: axiosError.response?.status,
      error: axiosError.message || 'Failed to reach GitHub',
    };
  }
}

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
