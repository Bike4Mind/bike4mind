import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@bike4mind/database', () => ({ BusinessMetricState: {} }));
import { comparisonWindow } from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import { deliverAnomalies, type DeliveryStore } from './deliver';

const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
const store: DeliveryStore = { claim: vi.fn(), complete: vi.fn(), release: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.claim).mockResolvedValue(true);
});

describe('anomaly Slack delivery', () => {
  it('leaves failed alerts retryable and never marks a rejected post delivered', async () => {
    const post = vi.fn().mockResolvedValue(false);
    await expect(deliverAnomalies(window, ['metric\nvalue'], post, store)).rejects.toThrow('Slack rejected');
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith(
      expect.stringContaining('alert:2026-10-26T12:00:00.000Z:'),
      expect.any(String)
    );
  });

  it('deduplicates metrics per window despite changing values on retries', async () => {
    const post = vi.fn().mockResolvedValue(true);
    await deliverAnomalies(window, ['metric\nvalue 1'], post, store);
    const firstId = vi.mocked(store.claim).mock.calls[0][0];
    vi.mocked(store.claim).mockResolvedValue(false);
    await deliverAnomalies(window, ['metric\nvalue 2'], post, store);
    expect(vi.mocked(store.claim).mock.calls[1][0]).toBe(firstId);
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith(firstId, expect.any(String), expect.any(Date));
  });
});
