import { describe, it, expect, vi } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import { userKeyProviders } from '../apiKeyService';
import {
  apiKeyProviderOf,
  asUserApiKeyRejection,
  UserApiKeyRejectedError,
  userApiKeyRejectedReply,
} from './userApiKeyRejection';

vi.mock('../apiKeyService', () => ({ userKeyProviders: vi.fn() }));

const keyTable = {};
const anthropicModel = { id: 'claude-x', backend: ModelBackend.Anthropic };
const withStatus = (status: number) => Object.assign(new Error(`${status} invalid x-api-key`), { status });

describe('apiKeyProviderOf', () => {
  it('routes a catalog row on its adapter family before its backend', () => {
    expect(apiKeyProviderOf({ backend: ModelBackend.Bedrock, adapterFamily: 'anthropic-messages' })).toBe('anthropic');
    expect(apiKeyProviderOf({ backend: ModelBackend.OpenAI, adapterFamily: 'bedrock-anthropic' })).toBeUndefined();
  });

  it('falls back to the backend, and has no key for keyless backends', () => {
    expect(apiKeyProviderOf({ backend: ModelBackend.Kimi })).toBe('kimi');
    expect(apiKeyProviderOf({ backend: ModelBackend.Bedrock })).toBeUndefined();
  });
});

describe('asUserApiKeyRejection', () => {
  it('wraps a 401 or 403 on a user key, keeping the provider message and status', () => {
    vi.mocked(userKeyProviders).mockReturnValue(new Set(['anthropic']));
    for (const status of [401, 403]) {
      const original = withStatus(status);
      const wrapped = asUserApiKeyRejection(original, anthropicModel, keyTable);
      expect(wrapped).toBeInstanceOf(UserApiKeyRejectedError);
      expect(wrapped).toMatchObject({ message: original.message, status, cause: original });
      expect(wrapped?.logFields).toEqual({ provider: 'anthropic', model: 'claude-x', status, keySource: 'user' });
    }
  });

  it('leaves a platform-key 401 and any other status alone', () => {
    vi.mocked(userKeyProviders).mockReturnValue(new Set(['openai']));
    expect(asUserApiKeyRejection(withStatus(401), anthropicModel, keyTable)).toBeUndefined();
    vi.mocked(userKeyProviders).mockReturnValue(new Set(['anthropic']));
    expect(asUserApiKeyRejection(withStatus(429), anthropicModel, keyTable)).toBeUndefined();
  });

  it('returns an already-wrapped rejection unchanged', () => {
    const wrapped = new UserApiKeyRejectedError('anthropic', 'claude-x', 401, { cause: withStatus(401) });
    expect(asUserApiKeyRejection(wrapped, anthropicModel, keyTable)).toBe(wrapped);
  });
});

it('userApiKeyRejectedReply names the provider and the remedy', () => {
  expect(userApiKeyRejectedReply('anthropic')).toBe(
    'Your Anthropic API key was rejected by the provider. Update or remove it in your API key settings.'
  );
});
