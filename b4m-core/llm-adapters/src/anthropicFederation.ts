import type { ClientOptions } from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { subjectTokenSource } from './wifTokenSource';

type AccessTokenProvider = NonNullable<ClientOptions['credentials']>;
type AccessToken = Awaited<ReturnType<AccessTokenProvider>>;

// Above the SDK's 120s advisory window, so a client never receives a token it would refresh at once.
const REUSE_MARGIN_SECONDS = 180;

/**
 * Shares one exchanged token across clients. Each Anthropic client wraps its provider in its own
 * TokenCache, and backends build a new client per request, so without this every request would
 * exchange again.
 */
export function reuseUntilNearExpiry(inner: AccessTokenProvider): AccessTokenProvider {
  let cached: AccessToken | undefined;
  let pending: Promise<AccessToken> | undefined;
  return opts => {
    const fresh = cached && (cached.expiresAt === null || cached.expiresAt - Date.now() / 1000 > REUSE_MARGIN_SECONDS);
    if (fresh && cached && !opts?.forceRefresh) return Promise.resolve(cached);
    if (opts?.forceRefresh) cached = undefined;
    pending ??= inner(opts)
      .then(token => (cached = token))
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

const providers = new Map<string, AccessTokenProvider>();

/**
 * Process-wide credentials for the federated Anthropic client when the subject token is minted
 * in-process (PROVIDER_WIF_TOKEN_SOURCE=aws-sts). The github-actions source keeps the SDK's own
 * env/file resolution instead.
 */
export function federatedAnthropicCredentials(): AccessTokenProvider {
  const federationRuleId = process.env.ANTHROPIC_FEDERATION_RULE_ID;
  const organizationId = process.env.ANTHROPIC_ORGANIZATION_ID;
  const audience = process.env.ANTHROPIC_WIF_AUDIENCE;
  if (!federationRuleId || !organizationId || !audience) {
    throw new Error(
      'ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_WIF_AUDIENCE are required for federated Anthropic auth'
    );
  }
  const serviceAccountId = process.env.ANTHROPIC_SERVICE_ACCOUNT_ID || undefined;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID || undefined;
  // Must match the host the client sends API requests to (the SDK reads the same variable).
  const baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  const cacheKey = JSON.stringify([federationRuleId, organizationId, serviceAccountId, workspaceId, audience, baseURL]);
  let provider = providers.get(cacheKey);
  if (!provider) {
    const getSubjectToken = subjectTokenSource('aws-sts');
    provider = reuseUntilNearExpiry(
      oidcFederationProvider({
        identityTokenProvider: () => getSubjectToken(audience),
        federationRuleId,
        organizationId,
        serviceAccountId,
        workspaceId,
        baseURL,
        fetch: (input, init) => fetch(input, init),
      })
    );
    providers.set(cacheKey, provider);
  }
  return provider;
}
