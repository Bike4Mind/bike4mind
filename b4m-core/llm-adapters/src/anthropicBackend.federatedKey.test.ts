import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTHROPIC_FEDERATED_KEY, AnthropicBackend } from './anthropicBackend';

const clientKey = (backend: AnthropicBackend) =>
  (backend as unknown as { _api: { apiKey: string | null } })._api.apiKey;

describe('AnthropicBackend federated key', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('builds the client with no key for the federated sentinel so the SDK resolves federation credentials', () => {
    expect(clientKey(new AnthropicBackend(ANTHROPIC_FEDERATED_KEY))).toBeNull();
  });

  it('passes a real key through unchanged', () => {
    expect(clientKey(new AnthropicBackend('sk-ant-test'))).toBe('sk-ant-test');
  });
});
