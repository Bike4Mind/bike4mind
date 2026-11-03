import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@bike4mind/database', () => ({ BusinessMetricState: {} }));
import {
  comparisonWindow,
  type BusinessMetricAnomaly,
} from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import { deliverAnomalies, type DeliveryStore } from './deliver';

const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
const anomaly = (
  metricName = 'credits',
  direction: BusinessMetricAnomaly['direction'] = 'increase',
  current = 300
): BusinessMetricAnomaly => ({
  metricName,
  direction,
  current,
  previous: 100,
  delta: current - 100,
  percent: current - 100,
  median: 110,
  contributors: [],
});
const postedText = (post: ReturnType<typeof vi.fn>, call = 0) => (post.mock.calls[call][0] as { text: string }).text;
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
    await deliverAnomalies(window, [anomaly('credits', 'increase', 300)], post, store);
    const firstId = vi.mocked(store.claim).mock.calls[0][0];
    vi.mocked(store.claim).mockResolvedValue(false);
    await deliverAnomalies(window, [anomaly('credits', 'increase', 400)], post, store);
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
    expect(await deliverAnomalies(close, [anomaly('credits', 'increase', 400)], post, store)).toBe(1);
    expect(await deliverAnomalies(close, [anomaly('credits', 'increase', 400)], post, store)).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.claim).mock.calls[2][0]).toContain('alert:2026-10-26:increase:daily:');
  });

  it('allows the opposite direction and the next UTC day independently', async () => {
    const post = vi.fn().mockResolvedValue(true);
    await deliverAnomalies(window, [anomaly()], post, store);
    await deliverAnomalies(window, [anomaly('credits', 'decrease', 50)], post, store);
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

  it("skips another invocation's lease and posts the remaining anomalies as one message", async () => {
    vi.mocked(store.claim).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const post = vi.fn().mockResolvedValue(true);
    const others = [anomaly('verifiedSignups', 'increase', 300), anomaly('activeUsers', 'decrease', 50)];
    expect(await deliverAnomalies(window, [anomaly(), ...others], post, store)).toBe(2);
    expect(post).toHaveBeenCalledTimes(1);
    expect(postedText(post)).toBe(
      'Business metrics, 12:00 UTC intraday compare: 2 anomalies: Verified signups up 200.0%, Active users down 50.0%'
    );
    expect(store.release).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledTimes(2);
  });

  it('posts nothing when every receipt is already taken', async () => {
    vi.mocked(store.claim).mockResolvedValue(false);
    const post = vi.fn().mockResolvedValue(true);
    expect(await deliverAnomalies(window, [anomaly(), anomaly('activeUsers')], post, store)).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('releases every claimed receipt when the grouped post is rejected', async () => {
    const post = vi.fn().mockResolvedValue(false);
    await expect(deliverAnomalies(window, [anomaly(), anomaly('activeUsers')], post, store)).rejects.toThrow(
      'Slack rejected'
    );
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('still completes the other receipts when one complete keeps failing after an accepted post', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const anomalies = [anomaly(), anomaly('activeUsers'), anomaly('verifiedSignups')];
    let firstId: string | undefined;
    vi.mocked(store.complete).mockImplementation(async id => {
      firstId ??= id;
      if (id === firstId) throw new Error('lease lost');
    });
    await expect(deliverAnomalies(window, anomalies, post, store)).rejects.toThrow('lease lost');
    const completedIds = new Set(vi.mocked(store.complete).mock.calls.map(([id]) => id));
    expect(completedIds.size).toBe(3);
    expect(store.complete).toHaveBeenCalledTimes(4);
    expect(store.release).not.toHaveBeenCalled();
  });

  it('rethrows the post error even when a release also fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('network'));
    vi.mocked(store.release).mockRejectedValueOnce(new Error('release failed'));
    await expect(deliverAnomalies(window, [anomaly(), anomaly('activeUsers')], post, store)).rejects.toThrow('network');
    expect(store.release).toHaveBeenCalledTimes(2);
  });

  it('renders admin links and the stage from the formatter options', async () => {
    const post = vi.fn().mockResolvedValue(true);
    const withMovers = {
      ...anomaly('credits', 'increase', 300),
      contributors: [{ label: 'user:6818b9a95d466aaf72b2e89e', value: 150 }],
    };
    await deliverAnomalies(window, [withMovers], post, store, { appUrl: 'https://app.example.com', stage: 'staging' });
    const body = JSON.stringify(post.mock.calls[0][0]);
    expect(body).toContain('https://app.example.com/admin/users/6818b9a95d466aaf72b2e89e|user');
    expect(body).toContain('https://app.example.com/admin?tab=analytics');
    expect(body).toContain('category business  |  staging  |  12:00 UTC, 26 Oct');
  });

  it('propagates database claim failures instead of treating them as lease contention', async () => {
    vi.mocked(store.claim).mockRejectedValue(new Error('database unavailable'));
    const post = vi.fn();
    await expect(deliverAnomalies(window, [anomaly()], post, store)).rejects.toThrow('database unavailable');
    expect(post).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
