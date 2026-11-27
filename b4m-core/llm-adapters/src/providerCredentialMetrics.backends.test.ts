import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordProviderCredentialUse } = vi.hoisted(() => ({ recordProviderCredentialUse: vi.fn() }));
vi.mock('./providerCredentialMetrics', () => ({ recordProviderCredentialUse }));

import { ANTHROPIC_FEDERATED_KEY, AnthropicBackend } from './anthropicBackend';
import { OPENAI_FEDERATED_KEY, OpenAIBackend } from './openaiBackend';

const OPENAI_FEDERATION_ENV = {
  OPENAI_IDENTITY_PROVIDER_ID: 'idp-test',
  OPENAI_SERVICE_ACCOUNT_ID: 'sa-test',
  OPENAI_WIF_AUDIENCE: 'https://api.openai.com/v1',
};

type Backend = AnthropicBackend | OpenAIBackend;
type Messages = Parameters<Backend['complete']>[1];
type Options = Parameters<Backend['complete']>[2];

const messages = [{ role: 'user', content: 'hi' }] as unknown as Messages;

// The metric is recorded before any request, so a client that fails on first use
// is enough to drive complete() without a network.
function withUnusableClient<T extends Backend>(backend: T): T {
  const failOnUse = new Proxy(
    {},
    {
      get() {
        throw new Error('no network in this test');
      },
    }
  );
  (backend as unknown as { _api: unknown })._api = failOnUse;
  return backend;
}

async function completeIgnoringFailure(backend: Backend, options: Options = { stream: false }): Promise<void> {
  await backend.complete('test-model', messages, options, async () => {}).catch(() => {});
}

describe('provider credential metric from the completion backends', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    recordProviderCredentialUse.mockReset();
    for (const [name, value] of Object.entries(OPENAI_FEDERATION_ENV)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
  });

  afterEach(() => {
    for (const name of Object.keys(OPENAI_FEDERATION_ENV)) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it.each([
    ['anthropic', 'static', () => new AnthropicBackend('sk-ant-test')],
    ['anthropic', 'federated', () => new AnthropicBackend(ANTHROPIC_FEDERATED_KEY)],
    ['openai', 'static', () => new OpenAIBackend('sk-test')],
    ['openai', 'federated', () => new OpenAIBackend(OPENAI_FEDERATED_KEY)],
  ] as const)('records %s as %s once per completion request', async (provider, credential, build) => {
    await completeIgnoringFailure(withUnusableClient(build()));

    expect(recordProviderCredentialUse).toHaveBeenCalledTimes(1);
    expect(recordProviderCredentialUse).toHaveBeenCalledWith(provider, credential);
  });

  it.each([
    ['anthropic', () => new AnthropicBackend(ANTHROPIC_FEDERATED_KEY)],
    ['openai', () => new OpenAIBackend(OPENAI_FEDERATED_KEY)],
  ] as const)(
    'records nothing for %s when a federated request is refused before it is sent',
    async (_provider, build) => {
      const abortAware: Options = {
        stream: false,
        retryMode: 'abort-aware',
        abortSignal: new AbortController().signal,
      };

      await completeIgnoringFailure(withUnusableClient(build()), abortAware);

      expect(recordProviderCredentialUse).not.toHaveBeenCalled();
    }
  );
});
