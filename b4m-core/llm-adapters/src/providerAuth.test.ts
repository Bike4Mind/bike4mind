import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFederatedSharedKeys } from './providerAuth';

const keys = { openai: 'sk-admin-openai', anthropic: 'sk-ant-admin', gemini: 'g-key' };
const bothShared = { openai: true, anthropic: true };

describe('withFederatedSharedKeys', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the same object when B4M_PROVIDER_AUTH is unset', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', '');
    expect(withFederatedSharedKeys(keys, bothShared)).toBe(keys);
  });

  it('returns the same object for any value other than federated', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'static');
    expect(withFederatedSharedKeys(keys, bothShared)).toBe(keys);
  });

  it('swaps shared admin keys for the sentinels in a copy, leaving the input untouched', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const result = withFederatedSharedKeys(keys, bothShared);
    expect(result).toEqual({ openai: 'federated', anthropic: 'federated', gemini: 'g-key' });
    expect(keys).toEqual({ openai: 'sk-admin-openai', anthropic: 'sk-ant-admin', gemini: 'g-key' });
  });

  it("never swaps a user's own key", () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const userKeys = { openai: 'sk-user', anthropic: 'sk-ant-admin' };
    expect(withFederatedSharedKeys(userKeys, { openai: false, anthropic: true })).toEqual({
      openai: 'sk-user',
      anthropic: 'federated',
    });
  });

  it('never swaps an expired key or a missing key, even if marked shared', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const table = { openai: 'expired', anthropic: null };
    expect(withFederatedSharedKeys(table, bothShared)).toBe(table);
  });

  it('does nothing without source information', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    expect(withFederatedSharedKeys(keys, undefined)).toBe(keys);
  });
});
