import type { Logger } from '@bike4mind/observability';
import { ProviderRateLimitError } from '@bike4mind/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ProviderCapacityOptions,
  ProviderBusyError,
  type ProviderSlotStore,
  runWithProviderCapacity,
} from './runWithProviderCapacity';

const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** A virtual clock: `sleep` advances time instantly, so budgets and deadlines are exact. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
  };
}

function slotStore(acquireResults: boolean[]): ProviderSlotStore & {
  tryAcquireLease: ReturnType<typeof vi.fn>;
  releaseLease: ReturnType<typeof vi.fn>;
} {
  const queue = [...acquireResults];
  return {
    tryAcquireLease: vi.fn(async () => queue.shift() ?? false),
    releaseLease: vi.fn(async () => {}),
  };
}

const rateLimited = (retryAfterMs: number | null = null) =>
  new ProviderRateLimitError('elevenlabs', 'concurrent_limit_exceeded', retryAfterMs);

describe('runWithProviderCapacity', () => {
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    clock = fakeClock();
    vi.clearAllMocks();
  });

  const options = (overrides: Partial<ProviderCapacityOptions> = {}): ProviderCapacityOptions => ({
    provider: 'elevenlabs',
    logger,
    budgetMs: 45_000,
    maxSlotWaitMs: 15_000,
    minAttemptMs: 25_000,
    maxRetries: 2,
    pollIntervalMs: 1_000,
    retryBaseDelayMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });

  it('runs the attempt with the full budget when unslotted', async () => {
    const attempt = vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => timeoutMs);

    await expect(runWithProviderCapacity(options(), attempt)).resolves.toBe(45_000);
  });

  it('holds a slot for the attempt and releases it afterwards', async () => {
    const store = slotStore([true]);
    const attempt = vi.fn(async () => {
      expect(store.releaseLease).not.toHaveBeenCalled();
      return 'audio';
    });

    await expect(runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 } }), attempt)).resolves.toBe(
      'audio'
    );

    expect(store.tryAcquireLease).toHaveBeenCalledWith('k', expect.any(String), 2, 50_000);
    expect(store.releaseLease).toHaveBeenCalledWith('k', store.tryAcquireLease.mock.calls[0][1]);
  });

  it('waits for a free slot and spends the wait out of the attempt budget', async () => {
    const store = slotStore([false, false, true]);
    const attempt = vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => timeoutMs);

    const timeoutMs = await runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 } }), attempt);

    expect(store.tryAcquireLease).toHaveBeenCalledTimes(3);
    expect(timeoutMs).toBe(45_000 - clock.now());
    expect(timeoutMs).toBeLessThan(45_000);
  });

  it('gives up with slots_exhausted and never calls the provider when no slot frees in time', async () => {
    const store = slotStore([]);
    const attempt = vi.fn();

    const error = await runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 } }), attempt).catch(
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(ProviderBusyError);
    expect(error).toMatchObject({ reason: 'slots_exhausted' });
    expect((error as ProviderBusyError).retryAfterSeconds).toBeGreaterThan(0);
    expect(attempt).not.toHaveBeenCalled();
    expect(store.releaseLease).not.toHaveBeenCalled();
    // Bounded by the wait cap, leaving the provider-attempt budget untouched.
    expect(clock.now()).toBeLessThanOrEqual(15_000);
  });

  it('never waits so long that the remaining budget falls below one worthwhile attempt', async () => {
    const store = slotStore([]);

    await runWithProviderCapacity(
      options({ slots: { store, key: 'k', limit: 2 }, maxSlotWaitMs: 40_000 }),
      vi.fn()
    ).catch(() => {});

    expect(clock.now()).toBeLessThanOrEqual(45_000 - 25_000);
  });

  it('runs unslotted when the slot store is down rather than failing the generation', async () => {
    const store = slotStore([]);
    store.tryAcquireLease.mockRejectedValue(new Error('mongo down'));

    await expect(
      runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 } }), async () => 'audio')
    ).resolves.toBe('audio');
    expect(logger.warn).toHaveBeenCalled();
    expect(store.releaseLease).not.toHaveBeenCalled();
  });

  it('retries an upstream 429 and succeeds, keeping the same slot', async () => {
    const store = slotStore([true]);
    const attempt = vi.fn().mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce('audio');

    await expect(
      runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 }, minAttemptMs: 15_000 }), attempt)
    ).resolves.toBe('audio');

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(store.tryAcquireLease).toHaveBeenCalledTimes(1);
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('honours the provider Retry-After hint as the backoff', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(rateLimited(3_000)).mockResolvedValueOnce('audio');

    await runWithProviderCapacity(options({ minAttemptMs: 15_000 }), attempt);

    expect(clock.sleep).toHaveBeenCalledWith(3_000);
  });

  it('stops after maxRetries with upstream_rate_limited and releases the slot', async () => {
    const store = slotStore([true]);
    const attempt = vi.fn().mockRejectedValue(rateLimited(1_000));

    const error = await runWithProviderCapacity(
      options({ slots: { store, key: 'k', limit: 2 }, minAttemptMs: 1_000 }),
      attempt
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({ reason: 'upstream_rate_limited', retryAfterSeconds: 1 });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the backoff would leave too little budget for another attempt', async () => {
    const attempt = vi.fn().mockRejectedValue(rateLimited(30_000));

    await expect(runWithProviderCapacity(options(), attempt)).rejects.toBeInstanceOf(ProviderBusyError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('propagates any other provider error unchanged and still releases the slot', async () => {
    const store = slotStore([true]);
    const failure = new Error('ElevenLabs music generation failed: 500');

    await expect(
      runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 } }), vi.fn().mockRejectedValue(failure))
    ).rejects.toBe(failure);
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed release, since the lease lapses on its own', async () => {
    const store = slotStore([true]);
    store.releaseLease.mockRejectedValue(new Error('mongo down'));

    await expect(
      runWithProviderCapacity(options({ slots: { store, key: 'k', limit: 2 } }), async () => 'audio')
    ).resolves.toBe('audio');
    expect(logger.warn).toHaveBeenCalled();
  });
});
