import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  federatedSharedKeyProviders,
  normalizeProviderCredential,
  parseProviderCredentialMode,
  providerCredentialSpec,
  resetProviderCredentialWarnings,
  withProviderCredentialPlan,
  type ProviderCredentialPlanInput,
} from './providerAuth';

const keys = { openai: 'sk-admin-openai', anthropic: 'sk-ant-admin', gemini: 'g-key' };
const SENTINEL = Symbol('test-federated');

const input = (overrides: Partial<ProviderCredentialPlanInput> = {}): ProviderCredentialPlanInput => ({
  platformKeys: { openai: true, anthropic: true },
  userKeys: new Set(),
  modes: { openai: 'federated', anthropic: 'federated' },
  ...overrides,
});

const specOf = (table: object, provider: 'openai' | 'anthropic', key: string) =>
  providerCredentialSpec(table, provider, key, SENTINEL);

describe('withProviderCredentialPlan', () => {
  beforeEach(() => resetProviderCredentialWarnings());
  afterEach(() => vi.unstubAllEnvs());

  it('federates a platform key in federated mode when the capability is deployed, keeping it as the fallback', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const result = withProviderCredentialPlan(keys, input());
    expect(result).toEqual(keys);
    expect(result).not.toBe(keys);
    expect(federatedSharedKeyProviders(result)).toEqual({ openai: true, anthropic: true });
    expect(specOf(result, 'anthropic', result.anthropic)).toEqual({ kind: 'federated', fallbackKey: 'sk-ant-admin' });
    expect(federatedSharedKeyProviders(keys)).toBeUndefined();
    expect(federatedSharedKeyProviders({ ...result })).toBeUndefined();
  });

  it('keeps a platform key static in static mode, even with the capability deployed', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const result = withProviderCredentialPlan(keys, input({ modes: { openai: 'static', anthropic: 'static' } }));
    expect(federatedSharedKeyProviders(result)).toEqual({ openai: false, anthropic: false });
    expect(specOf(result, 'openai', result.openai)).toEqual({ kind: 'static', key: 'sk-admin-openai' });
  });

  it('uses the static key and warns once when the mode is federated but the capability is absent', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', '');
    const logger = { warn: vi.fn() };
    const first = withProviderCredentialPlan(keys, input({ logger }));
    withProviderCredentialPlan(keys, input({ logger }));
    expect(specOf(first, 'anthropic', first.anthropic)).toEqual({ kind: 'static', key: 'sk-ant-admin' });
    expect(federatedSharedKeyProviders(first)).toEqual({ openai: false, anthropic: false });
    // Once per provider per process, not once per request.
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map(([message]) => message).join('\n')).toMatch(
      /openaiCredentialMode[\s\S]*anthropic/
    );
  });

  it("marks a user's own key as user_key and never federates it", () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const table = { openai: 'sk-user', anthropic: 'sk-ant-admin' };
    const result = withProviderCredentialPlan(
      table,
      input({ platformKeys: { openai: false, anthropic: true }, userKeys: new Set(['openai']) })
    );
    expect(specOf(result, 'openai', result.openai)).toEqual({ kind: 'user_key', key: 'sk-user' });
    expect(federatedSharedKeyProviders(result)).toEqual({ openai: false, anthropic: true });
  });

  it('never marks an expired key or a missing key, even if marked shared', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const table = { openai: 'expired', anthropic: null };
    expect(withProviderCredentialPlan(table, input())).toBe(table);
    expect(federatedSharedKeyProviders(table)).toBeUndefined();
  });

  it('counts a key of unknown origin (a self-host env key) as static', () => {
    vi.stubEnv('B4M_PROVIDER_AUTH', 'federated');
    const table = { openai: 'federated', anthropic: 'federated' };
    const result = withProviderCredentialPlan(table, input({ platformKeys: undefined }));
    expect(result).toBe(table);
    expect(specOf(result, 'openai', 'federated')).toEqual({ kind: 'static', key: 'federated' });
  });
});

describe('parseProviderCredentialMode', () => {
  it.each([
    ['federated', 'federated'],
    ['static', 'static'],
    ['', 'static'],
    [undefined, 'static'],
    ['FEDERATED', 'static'],
  ])('reads %j as %s', (value, mode) => {
    expect(parseProviderCredentialMode(value)).toBe(mode);
  });
});

describe('normalizeProviderCredential', () => {
  it('reads a plain string as a static key and the bare sentinel as federated with no fallback', () => {
    expect(normalizeProviderCredential('sk-x', SENTINEL)).toEqual({ kind: 'static', key: 'sk-x' });
    expect(normalizeProviderCredential(SENTINEL, SENTINEL)).toEqual({ kind: 'federated', fallbackKey: null });
  });

  it('rejects a foreign symbol or a key table', () => {
    expect(() => normalizeProviderCredential(Symbol('other') as typeof SENTINEL, SENTINEL)).toThrow(TypeError);
    expect(() => normalizeProviderCredential({ openai: 'sk-x' } as never, SENTINEL)).toThrow(TypeError);
  });
});
