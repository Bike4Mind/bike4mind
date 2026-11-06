import { beforeEach, describe, expect, it, vi } from 'vitest';
const clearSignupNetworkBefore = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ subscriberRepository: { clearSignupNetworkBefore } }));
import { runSubscriberNetworkRetention } from './subscriberNetworkRetention';

beforeEach(() => {
  vi.clearAllMocks();
  clearSignupNetworkBefore.mockResolvedValue(3);
});

describe('runSubscriberNetworkRetention', () => {
  it('clears waitlist network captured more than 90 days ago', async () => {
    const result = await runSubscriberNetworkRetention({ now: new Date('2026-11-06T00:00:00Z') });
    expect(clearSignupNetworkBefore).toHaveBeenCalledExactlyOnceWith(new Date('2026-08-08T00:00:00Z'));
    expect(result).toEqual({ clearedCount: 3, cutoff: '2026-08-08T00:00:00.000Z' });
  });

  it('propagates a database failure so the job reports it', async () => {
    clearSignupNetworkBefore.mockRejectedValueOnce(new Error('offline'));
    await expect(runSubscriberNetworkRetention()).rejects.toThrow('offline');
  });
});
