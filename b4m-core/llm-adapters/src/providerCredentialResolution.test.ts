import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordProviderCredentialUse } = vi.hoisted(() => ({ recordProviderCredentialUse: vi.fn() }));
vi.mock('./providerCredentialMetrics', () => ({ recordProviderCredentialUse }));

import {
  EXCHANGE_BACKOFF_MS,
  EXCHANGE_DEADLINE_MS,
  resetProviderCredentialBackoff,
  resolveCredentialBeforeSend,
  type ResolveCredentialInput,
} from './providerCredentialResolution';

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
    resetProviderCredentialBackoff();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not be built/);
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
    ).rejects.toMatchObject({ message: 'anthropic federated token exchange failed', cause });
    expect(recordProviderCredentialUse).not.toHaveBeenCalled();
  });

  it('rethrows an abort while exchanging, recording nothing and starting no backoff', async () => {
    const controller = new AbortController();
    const exchange = vi.fn(() => new Promise<void>(() => {}));
    const pending = resolveWith({ exchange, signal: controller.signal });
    controller.abort(new Error('user aborted'));
    await expect(pending).rejects.toThrow('user aborted');
    expect(recordProviderCredentialUse).not.toHaveBeenCalled();
    await expect(resolveWith({})).resolves.toEqual({ kind: 'federated' });
  });

  it('goes straight to the static key during the backoff, warning only on the failure itself', async () => {
    const exchange = vi.fn(async () => {
      throw new Error('exchange refused');
    });
    await resolveWith({ exchange });
    const second = await resolveWith({ exchange });
    expect(second.kind).toBe('static_fallback');
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(recordProviderCredentialUse.mock.calls).toEqual([
      ['anthropic', 'static_fallback'],
      ['anthropic', 'static_fallback'],
    ]);
  });

  it('never backs off a federated spec with no fallback key: each call exchanges again', async () => {
    const exchange = vi.fn(async () => {
      throw new Error('exchange refused');
    });
    const spec = { kind: 'federated', fallbackKey: null } as const;
    await expect(resolveWith({ spec, exchange })).rejects.toThrow();
    await expect(resolveWith({ spec, exchange })).rejects.toThrow();
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('gives up on a hung exchange at the deadline: falls back with a key, and without one fails as a non-abort', async () => {
    vi.useFakeTimers();
    const hung = () => new Promise<void>(() => {});
    const withKey = resolveWith({ exchange: hung });
    await vi.advanceTimersByTimeAsync(EXCHANGE_DEADLINE_MS);
    await expect(withKey).resolves.toMatchObject({ kind: 'static_fallback', key: 'sk-platform' });

    resetProviderCredentialBackoff();
    const withoutKey = resolveWith({ spec: { kind: 'federated', fallbackKey: null }, exchange: hung });
    const settled = withoutKey.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(EXCHANGE_DEADLINE_MS);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/abort/i);
  });

  it('never starts an exchange for an already aborted call', async () => {
    const exchange = vi.fn(async () => {});
    await expect(resolveWith({ exchange, signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('backs off per provider and only for EXCHANGE_BACKOFF_MS', async () => {
    vi.useFakeTimers();
    const failing = vi.fn(async () => {
      throw new Error('exchange refused');
    });
    await resolveWith({ exchange: failing });

    const openaiExchange = vi.fn(async () => {});
    await expect(resolveWith({ provider: 'openai', exchange: openaiExchange })).resolves.toEqual({ kind: 'federated' });
    expect(openaiExchange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(EXCHANGE_BACKOFF_MS - 1);
    await resolveWith({ exchange: failing });
    expect(failing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(resolveWith({})).resolves.toEqual({ kind: 'federated' });
  });
});
