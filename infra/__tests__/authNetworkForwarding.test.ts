/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_NETWORK_HEADERS, AUTH_NETWORK_PATHS } from '../authNetworkForwarding';

const mocks = vi.hoisted(() => {
  const defaultBehavior = {
    targetOriginId: 'default',
    originRequestPolicyId: 'managed-except-host',
    cachePolicyId: 'server-cache',
    allowedMethods: ['GET', 'HEAD', 'POST'],
    functionAssociations: [{ eventType: 'viewer-request', functionArn: 'router-request' }],
    lambdaFunctionAssociations: [{ eventType: 'origin-request', lambdaArn: 'existing-signer' }],
  };
  type CdnConfig = {
    defaultCacheBehavior: typeof defaultBehavior;
    orderedCacheBehaviors?: (typeof defaultBehavior & { pathPattern: string })[];
  };
  const cdn: CdnConfig = { defaultCacheBehavior: defaultBehavior };
  const output = { apply: (callback: (value: string) => string) => callback('https://example.test/') };
  const policy = vi.fn(function (_name: string, _args: unknown) {
    return { id: 'auth-network-policy' };
  });
  const router = vi.fn(function (_name: string, args: { transform: { cdn: (config: CdnConfig) => void } }) {
    args.transform.cdn(cdn);
    return { url: output };
  });
  Object.assign(router, { get: () => ({ url: output }) });
  return { cdn, defaultBehavior, policy, router };
});

vi.mock('../waf', () => ({ wafWebAcl: undefined }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function loadRouter(
  shared = false,
  prodCachePolicyId = '',
  sharedOriginRequestPolicyId = '',
  stage = 'production',
  sharedResponseFunctionArn = ''
) {
  vi.resetModules();
  mocks.cdn.defaultCacheBehavior = mocks.defaultBehavior;
  delete mocks.cdn.orderedCacheBehaviors;
  vi.stubEnv('DEV_ROUTER_DISTRIBUTION_ID', shared ? 'shared-router' : '');
  vi.stubEnv('PROD_CACHE_POLICY_ID', prodCachePolicyId);
  vi.stubEnv('STAGING_CACHE_POLICY_ID', '');
  vi.stubEnv('AUTH_NETWORK_ORIGIN_REQUEST_POLICY_ID', sharedOriginRequestPolicyId);
  vi.stubEnv('SERVER_DOMAIN', 'example.test');
  vi.stubEnv('APP_CERT_ARN', '');
  vi.stubEnv('IS_PREVIEW', '');
  vi.stubEnv('PREVIEW_SHARED_RESPONSE_FUNCTION_ARN', sharedResponseFunctionArn);
  vi.stubGlobal('$app', { stage });
  vi.stubGlobal('$output', <T>(value: T) => ({ apply: <R>(callback: (resolved: T) => R) => callback(value) }));
  vi.stubGlobal('$dev', shared);
  vi.stubGlobal('$transform', vi.fn());
  vi.stubGlobal('$interpolate', (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((result, part, index) => result + part + (values[index] ?? ''), '')
  );
  vi.stubGlobal('aws', { cloudfront: { OriginRequestPolicy: mocks.policy, Function: {} } });
  vi.stubGlobal('random', {
    RandomPassword: class {
      result = 'synthetic-secret';
    },
  });
  vi.stubGlobal('sst', { aws: { Router: mocks.router, dns: vi.fn() }, Linkable: class {} });
  await import('../router');
}

describe('authentication connection metadata forwarding', () => {
  it('requests CloudFront-generated JA4 and network metadata while preserving viewer auth inputs', async () => {
    await loadRouter();
    expect(mocks.policy).toHaveBeenCalledWith('AuthNetworkOriginRequestPolicy', {
      comment: 'Forward trusted connection metadata on authentication requests',
      headersConfig: {
        headerBehavior: 'allViewerAndWhitelistCloudFront',
        headers: { items: AUTH_NETWORK_HEADERS },
      },
      cookiesConfig: { cookieBehavior: 'all' },
      queryStringsConfig: { queryStringBehavior: 'all' },
    });
    expect(AUTH_NETWORK_HEADERS).toContain('cloudfront-viewer-ja4-fingerprint');
  });

  it('covers sign-in, signup and checkout routes without changing the S3/default policy', async () => {
    await loadRouter();
    expect(mocks.cdn.orderedCacheBehaviors?.map(behavior => behavior.pathPattern)).toEqual([
      '/api/auth/*',
      '/api/otc/*',
      '/api/oauth/*',
      '/api/subscriptions/*',
      '/api/organizations/subscriptions/*',
      '/api/stripe/*',
    ]);
    expect(mocks.cdn.defaultCacheBehavior).toEqual(mocks.defaultBehavior);
    for (const behavior of mocks.cdn.orderedCacheBehaviors ?? []) {
      expect(behavior).toEqual({
        ...mocks.defaultBehavior,
        pathPattern: behavior.pathPattern,
        originRequestPolicyId: 'auth-network-policy',
      });
    }
  });

  it('carries the shared cache policy override onto the authentication behaviors', async () => {
    await loadRouter(false, 'shared-prod-cache');
    expect(mocks.cdn.defaultCacheBehavior.cachePolicyId).toBe('shared-prod-cache');
    expect(mocks.cdn.orderedCacheBehaviors).toHaveLength(AUTH_NETWORK_PATHS.length);
    for (const behavior of mocks.cdn.orderedCacheBehaviors ?? []) {
      expect(behavior.cachePolicyId).toBe('shared-prod-cache');
    }
  });

  it('attaches the account-level policy instead of creating one when its id is configured', async () => {
    await loadRouter(false, '', 'shared-auth-network-policy');
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.cdn.orderedCacheBehaviors).toHaveLength(AUTH_NETWORK_PATHS.length);
    for (const behavior of mocks.cdn.orderedCacheBehaviors ?? []) {
      expect(behavior.originRequestPolicyId).toBe('shared-auth-network-policy');
    }
  });

  it("keeps the preview's shared viewer-response function on the authentication behaviors", async () => {
    await loadRouter(false, '', '', 'pr123', 'shared-response-function');
    const sharedResponse = { eventType: 'viewer-response', functionArn: 'shared-response-function' };
    expect(mocks.cdn.defaultCacheBehavior.functionAssociations).toContainEqual(sharedResponse);
    expect(mocks.cdn.orderedCacheBehaviors).toHaveLength(AUTH_NETWORK_PATHS.length);
    for (const behavior of mocks.cdn.orderedCacheBehaviors ?? []) {
      expect(behavior.functionAssociations).toEqual(mocks.cdn.defaultCacheBehavior.functionAssociations);
    }
  });

  it("does not provision or change policies when using another stage's shared router", async () => {
    await loadRouter(true);
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.router).not.toHaveBeenCalled();
  });
});
