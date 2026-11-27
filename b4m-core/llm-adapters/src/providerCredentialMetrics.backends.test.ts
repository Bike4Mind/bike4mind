import { ChatModels } from '@bike4mind/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordProviderCredentialUse, anthropicExchange, openaiExchange } = vi.hoisted(() => ({
  recordProviderCredentialUse: vi.fn(),
  anthropicExchange: vi.fn(),
  openaiExchange: vi.fn(),
}));
vi.mock('./providerCredentialMetrics', () => ({ recordProviderCredentialUse }));
// The provider-side token exchanges, so a test decides whether federation succeeds.
vi.mock('@anthropic-ai/sdk/lib/credentials/oidc-federation', () => ({
  oidcFederationProvider: () => () => anthropicExchange(),
}));
vi.mock('openai/auth/workload-identity-auth', () => ({
  WorkloadIdentityAuth: vi.fn().mockImplementation(function () {
    return { getToken: () => openaiExchange() };
  }),
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(function () {
    return { send: async () => ({ WebIdentityToken: 'sts-jwt' }) };
  }),
  GetWebIdentityTokenCommand: vi.fn(),
}));

import { ANTHROPIC_FEDERATED_KEY, AnthropicBackend } from './anthropicBackend';
import { OPENAI_FEDERATED_KEY, OpenAIBackend } from './openaiBackend';
import type { ProviderCredentialSpec } from './providerAuth';

type Backend = AnthropicBackend | OpenAIBackend;
type Messages = Parameters<Backend['complete']>[1];
type Options = Parameters<Backend['complete']>[2];
type Provider = 'anthropic' | 'openai';

const messages = [{ role: 'user', content: 'hi' }] as unknown as Messages;
const FEDERATED_TOKEN = 'federated-access-token';
const PLATFORM_KEY = 'sk-platform';

// A fresh config per test, so the process-wide federated client caches never carry a token over.
let configSeq = 0;
function stubFederationEnv(): void {
  configSeq += 1;
  vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
  vi.stubEnv('PROVIDER_WIF_TOKEN_SOURCE', 'aws-sts');
  vi.stubEnv('ANTHROPIC_FEDERATION_RULE_ID', `fdrl_${configSeq}`);
  vi.stubEnv('ANTHROPIC_ORGANIZATION_ID', 'org-test');
  vi.stubEnv('ANTHROPIC_WIF_AUDIENCE', 'https://aud.example');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('OPENAI_IDENTITY_PROVIDER_ID', 'idp-test');
  vi.stubEnv('OPENAI_SERVICE_ACCOUNT_ID', 'sa-test');
  vi.stubEnv('OPENAI_WIF_AUDIENCE', `aud-${configSeq}`);
  vi.stubEnv('OPENAI_API_KEY', '');
}

/** Every provider API request, by the credential it carried. Answers each with a 400 (not retried). */
function stubProviderApi(): { credentials: string[] } {
  const sent = { credentials: [] as string[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: { headers?: HeadersInit }) => {
      const headers = new Headers(init?.headers);
      sent.credentials.push(headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'rejected in test' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    })
  );
  return sent;
}

const build = (provider: Provider, credential: ProviderCredentialSpec) =>
  provider === 'anthropic' ? new AnthropicBackend(credential) : new OpenAIBackend(credential);
const modelFor = (provider: Provider) => (provider === 'anthropic' ? ChatModels.CLAUDE_4_5_HAIKU : ChatModels.GPT4o);

async function completeIgnoringFailure(backend: Backend, provider: Provider, options: Options = { stream: false }) {
  await backend.complete(modelFor(provider), messages, options, async () => {}).catch(() => {});
}

const exchangeSucceeds = () => {
  anthropicExchange.mockResolvedValue({ token: FEDERATED_TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  openaiExchange.mockResolvedValue(FEDERATED_TOKEN);
};

describe.each(['anthropic', 'openai'] as const)('%s backend credential resolution', provider => {
  let sent: { credentials: string[] };

  beforeEach(() => {
    recordProviderCredentialUse.mockReset();
    anthropicExchange.mockReset();
    openaiExchange.mockReset();
    stubFederationEnv();
    sent = stubProviderApi();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends the platform key and records static', async () => {
    await completeIgnoringFailure(build(provider, { kind: 'static', key: PLATFORM_KEY }), provider);
    expect(sent.credentials).toEqual([PLATFORM_KEY]);
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith(provider, 'static');
  });

  it("sends a user's own key and records user_key", async () => {
    await completeIgnoringFailure(build(provider, { kind: 'user_key', key: 'sk-user' }), provider);
    expect(sent.credentials).toEqual(['sk-user']);
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith(provider, 'user_key');
  });

  it('sends the federated token and records federated', async () => {
    exchangeSucceeds();
    await completeIgnoringFailure(build(provider, { kind: 'federated', fallbackKey: PLATFORM_KEY }), provider);
    expect(sent.credentials).toEqual([FEDERATED_TOKEN]);
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith(provider, 'federated');
  });

  it('falls back to the platform key once when the exchange fails, recording only static_fallback', async () => {
    anthropicExchange.mockRejectedValue(new Error('WorkloadIdentityError: exchange refused'));
    openaiExchange.mockRejectedValue(new Error('Token exchange failed with status 403'));
    await completeIgnoringFailure(build(provider, { kind: 'federated', fallbackKey: PLATFORM_KEY }), provider);
    expect(sent.credentials).toEqual([PLATFORM_KEY]);
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith(provider, 'static_fallback');
  });

  it('never falls back on a provider API error after the federated request was sent', async () => {
    exchangeSucceeds();
    const backend = build(provider, { kind: 'federated', fallbackKey: PLATFORM_KEY });
    await expect(
      backend.complete(modelFor(provider), messages, { stream: false }, async () => {})
    ).rejects.toBeDefined();
    // Sent exactly once, with the federated token; the platform key never went out.
    expect(sent.credentials).toEqual([FEDERATED_TOKEN]);
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith(provider, 'federated');
  });

  it('records nothing when a federated request is refused before it is sent (abort-aware retry)', async () => {
    const sentinel = provider === 'anthropic' ? ANTHROPIC_FEDERATED_KEY : OPENAI_FEDERATED_KEY;
    const backends = [
      build(provider, { kind: 'federated', fallbackKey: PLATFORM_KEY }),
      provider === 'anthropic'
        ? new AnthropicBackend(sentinel as typeof ANTHROPIC_FEDERATED_KEY)
        : new OpenAIBackend(sentinel as typeof OPENAI_FEDERATED_KEY),
    ];
    for (const backend of backends) {
      await completeIgnoringFailure(backend, provider, {
        stream: false,
        retryMode: 'abort-aware',
        abortSignal: new AbortController().signal,
      });
    }
    expect(sent.credentials).toEqual([]);
    expect(recordProviderCredentialUse).not.toHaveBeenCalled();
  });
});
