import { afterEach, describe, expect, it, vi } from 'vitest';
import { federatedSharedKeyProviders, withFederatedSharedKeys } from './providerAuth';

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

  it('marks only the returned copy and retains static key values', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const result = withFederatedSharedKeys(keys, bothShared);
    expect(result).toEqual(keys);
    expect(result).not.toBe(keys);
    expect(federatedSharedKeyProviders(result)).toEqual(bothShared);
    expect(federatedSharedKeyProviders(keys)).toBeUndefined();
    expect(federatedSharedKeyProviders({ ...result })).toBeUndefined();
    expect(keys).toEqual({ openai: 'sk-admin-openai', anthropic: 'sk-ant-admin', gemini: 'g-key' });
  });

  it("never federates a user's own key", () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const userKeys = { openai: 'sk-user', anthropic: 'sk-ant-admin' };
    const result = withFederatedSharedKeys(userKeys, { openai: false, anthropic: true });
    expect(result).toEqual(userKeys);
    expect(federatedSharedKeyProviders(result)).toEqual({ openai: false, anthropic: true });
  });

  it('never federates an expired key or a missing key, even if marked shared', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const table = { openai: 'expired', anthropic: null };
    expect(withFederatedSharedKeys(table, bothShared)).toBe(table);
    expect(federatedSharedKeyProviders(table)).toBeUndefined();
  });

  it('does not grant federation to a user key equal to the old sentinel', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const table = { openai: 'federated', anthropic: 'federated' };
    expect(withFederatedSharedKeys(table, { openai: false, anthropic: false })).toBe(table);
    expect(federatedSharedKeyProviders(table)).toBeUndefined();
  });

  it('does nothing without source information', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    expect(withFederatedSharedKeys(keys, undefined)).toBe(keys);
  });
});
