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

  it('deduplicates intraday cutoffs but delivers and deduplicates the midnight close separately', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const deliveredIds = new Set<string>();
    vi.mocked(store.claim).mockImplementation(async id => !deliveredIds.has(id));
    vi.mocked(store.complete).mockImplementation(async id => {
      deliveredIds.add(id);
    });
    expect(await deliverAnomalies(window, [anomaly()], post, store)).toBe(1);
    expect(await deliverAnomalies(comparisonWindow(new Date('2026-10-26T13:05:00Z')), [anomaly()], post, store)).toBe(
      0
    );
    const close = comparisonWindow(new Date('2026-10-27T00:05:00Z'));
    expect(await deliverAnomalies(close, [anomaly('metric\nvalue 300%')], post, store)).toBe(1);
    expect(await deliverAnomalies(close, [anomaly('metric\nvalue 300%')], post, store)).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.claim).mock.calls[2][0]).toContain('alert:2026-10-26:increase:daily:');
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

  it("skips another invocation's lease and continues with other anomalies", async () => {
    vi.mocked(store.claim).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const post = vi.fn().mockResolvedValue(true);
    const nextAnomaly = { ...anomaly('another metric'), metricName: 'other' };
    expect(await deliverAnomalies(window, [anomaly(), nextAnomaly], post, store)).toBe(1);
    expect(post).toHaveBeenCalledExactlyOnceWith('another metric');
    expect(store.release).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledTimes(1);
  });

  it('propagates database claim failures instead of treating them as lease contention', async () => {
    vi.mocked(store.claim).mockRejectedValue(new Error('database unavailable'));
    const post = vi.fn();
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('database unavailable');
    expect(post).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
