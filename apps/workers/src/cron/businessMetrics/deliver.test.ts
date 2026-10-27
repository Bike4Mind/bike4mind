import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@bike4mind/database', () => ({ BusinessMetricState: {} }));
import {
  comparisonWindow,
  type BusinessMetricAnomaly,
} from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import { deliverAnomalies, type DeliveryStore } from './deliver';

const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
const anomaly = (
  message = 'metric\nvalue',
  direction: BusinessMetricAnomaly['direction'] = 'increase'
): BusinessMetricAnomaly => ({
  metricName: 'metric',
  direction,
  message,
});
const store: DeliveryStore = { claim: vi.fn(), complete: vi.fn(), release: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(store.claim).mockResolvedValue(true);
  vi.mocked(store.complete).mockResolvedValue(undefined);
  vi.mocked(store.release).mockResolvedValue(undefined);
});

describe('anomaly Slack delivery', () => {
  it('leaves failed alerts retryable and never marks a rejected post delivered', async () => {
    const post = vi.fn().mockResolvedValue(false);
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('Slack rejected');
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith(
      expect.stringContaining('alert:2026-10-26:increase:'),
      expect.any(String)
    );
  });

  it('deduplicates metrics per day despite changing values on retries', async () => {
    const post = vi.fn().mockResolvedValue(true);
    await deliverAnomalies(window, [anomaly('metric\nvalue 1')], post, store);
    const firstId = vi.mocked(store.claim).mock.calls[0][0];
    vi.mocked(store.claim).mockResolvedValue(false);
    await deliverAnomalies(window, [anomaly('metric\nvalue 2')], post, store);
    expect(vi.mocked(store.claim).mock.calls[1][0]).toBe(firstId);
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith(firstId, expect.any(String), expect.any(Date));
  });

  it('shares a receipt across intraday cutoffs and the midnight close of the same UTC day', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const deliveredIds = new Set<string>();
    vi.mocked(store.claim).mockImplementation(async id => !deliveredIds.has(id));
    vi.mocked(store.complete).mockImplementation(async id => {
      deliveredIds.add(id);
    });
    expect(await deliverAnomalies(window, [anomaly()], post, store)).toBe(1);
    for (const at of ['2026-10-26T13:05:00Z', '2026-10-27T00:05:00Z']) {
      expect(await deliverAnomalies(comparisonWindow(new Date(at)), [anomaly()], post, store)).toBe(0);
    }
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('allows the opposite direction and the next UTC day independently', async () => {
    const post = vi.fn().mockResolvedValue(true);
    await deliverAnomalies(window, [anomaly()], post, store);
    await deliverAnomalies(window, [anomaly('metric down', 'decrease')], post, store);
    await deliverAnomalies(comparisonWindow(new Date('2026-10-27T01:05:00Z')), [anomaly()], post, store);
    const ids = vi.mocked(store.claim).mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toContain('alert:2026-10-26:decrease:');
    expect(ids[2]).toContain('alert:2026-10-27:increase:');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('retries a failed post at a later cutoff without consuming the daily receipt', async () => {
    const post = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('Slack rejected');
    expect(await deliverAnomalies(comparisonWindow(new Date('2026-10-26T13:05:00Z')), [anomaly()], post, store)).toBe(
      1
    );
    expect(vi.mocked(store.claim).mock.calls[0][0]).toBe(vi.mocked(store.claim).mock.calls[1][0]);
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease and retries complete once after an accepted post', async () => {
    const post = vi.fn().mockResolvedValue(true);
    vi.mocked(store.complete).mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined);
    expect(await deliverAnomalies(window, [anomaly()], post, store)).toBe(1);
    expect(store.complete).toHaveBeenCalledTimes(2);
    expect(store.release).not.toHaveBeenCalled();
  });

  it('rethrows without releasing when complete keeps failing after an accepted post', async () => {
    const post = vi.fn().mockResolvedValue(true);
    vi.mocked(store.complete).mockRejectedValue(new Error('db down'));
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('db down');
    expect(store.complete).toHaveBeenCalledTimes(2);
    expect(store.release).not.toHaveBeenCalled();
  });

  it('releases the lease when the post itself throws', async () => {
    const post = vi.fn().mockRejectedValue(new Error('network'));
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('network');
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it("does not post or release another invocation's active lease", async () => {
    vi.mocked(store.claim).mockRejectedValue(new Error('leased'));
    const post = vi.fn();
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('leased');
    expect(post).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
