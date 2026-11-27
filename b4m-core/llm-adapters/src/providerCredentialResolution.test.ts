import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordProviderCredentialUse } = vi.hoisted(() => ({ recordProviderCredentialUse: vi.fn() }));
vi.mock('./providerCredentialMetrics', () => ({ recordProviderCredentialUse }));

import { resolveCredentialBeforeSend, type ResolveCredentialInput } from './providerCredentialResolution';

const logger = { warn: vi.fn() };
const resolveWith = (overrides: Partial<ResolveCredentialInput>) =>
  resolveCredentialBeforeSend({
    provider: 'anthropic',
    spec: { kind: 'federated', fallbackKey: 'sk-platform' },
    setupError: undefined,
    exchange: async () => {},
    logger,
    ...overrides,
  });

describe('resolveCredentialBeforeSend', () => {
  beforeEach(() => {
    recordProviderCredentialUse.mockReset();
    logger.warn.mockReset();
  });

  it.each([
    [{ kind: 'static', key: 'sk-platform' }, 'static'],
    [{ kind: 'user_key', key: 'sk-user' }, 'user_key'],
  ] as const)('passes a %j credential through without an exchange and records %s', async (spec, recorded) => {
    const exchange = vi.fn(async () => {});
    await expect(resolveWith({ spec, exchange })).resolves.toEqual(spec);
    expect(exchange).not.toHaveBeenCalled();
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith('anthropic', recorded);
  });

  it('records federated when the exchange succeeds', async () => {
    await expect(resolveWith({})).resolves.toEqual({ kind: 'federated' });
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith('anthropic', 'federated');
  });

  it('falls back to the static key once when the exchange fails, and records only static_fallback', async () => {
    const cause = new Error('GetWebIdentityToken: AccessDenied');
    const resolved = await resolveWith({
      exchange: async () => {
        throw cause;
      },
    });
    expect(resolved).toEqual({ kind: 'static_fallback', key: 'sk-platform', cause });
    expect(recordProviderCredentialUse).toHaveBeenCalledExactlyOnceWith('anthropic', 'static_fallback');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back without exchanging when the federated client could not be built', async () => {
    const exchange = vi.fn(async () => {});
    const resolved = await resolveWith({ setupError: new Error('missing env'), exchange });
    expect(resolved.kind).toBe('static_fallback');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('rethrows and records nothing for the bare sentinel, which has no fallback key', async () => {
    const cause = new Error('exchange failed');
    await expect(
      resolveWith({
        spec: { kind: 'federated', fallbackKey: null },
        exchange: async () => {
          throw cause;
        },
      })
    ).rejects.toBe(cause);
    expect(recordProviderCredentialUse).not.toHaveBeenCalled();
  });
});
