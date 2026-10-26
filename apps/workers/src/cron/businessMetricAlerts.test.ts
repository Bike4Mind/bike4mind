import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metric } from '@bike4mind/server-utils/analytics/businessMetricAnomalies';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  sample: vi.fn(),
  connect: vi.fn(),
  post: vi.fn(),
  settings: vi.fn(),
  resource: { App: { stage: 'dev' } },
}));
vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/database', () => ({ connectDB: mocks.connect, adminSettingsRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: mocks.settings,
  getSettingsValue: (_name: string, settings: { webhook: string }) => settings.webhook,
  postMessageToSlack: mocks.post,
}));
vi.mock('./businessMetrics/collect', () => ({ collectBusinessMetrics: mocks.collect }));
vi.mock('./businessMetrics/deliver', async importOriginal => {
  const original = await importOriginal<typeof import('./businessMetrics/deliver')>();
  return {
    subscriberMetric: mocks.sample,
    deliverAnomalies: (
      window: Parameters<typeof original.deliverAnomalies>[0],
      messages: string[],
      post: (message: string) => Promise<boolean>
    ) =>
      original.deliverAnomalies(window, messages, post, {
        claim: async () => true,
        complete: async () => undefined,
        release: async () => undefined,
      }),
  };
});
import { handler } from './businessMetricAlerts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.resource.App.stage = 'dev';
  mocks.settings.mockResolvedValue({ webhook: 'https://example.test/slack' });
  mocks.post.mockResolvedValue(true);
  mocks.sample.mockResolvedValue({ name: 'payingSubscribers', values: [1, null], contributors: [] });
  const metric: Metric = {
    name: 'requests:user',
    values: [120, 100, 100, 100, 100, 100, 100, 100],
    contributors: [{ label: 'model:large', value: 120 }],
  };
  mocks.collect.mockResolvedValue({ metrics: [metric], subscribers: 1, subscriberContributors: [] });
});

describe('scheduled business metric alert', () => {
  it('delivers a seeded >5% anomaly to the configured staging Slack destination', async () => {
    expect(await handler({ time: '2026-10-26T12:05:00Z' })).toMatchObject({ anomalies: 1, delivered: 1 });
    expect(mocks.post).toHaveBeenCalledWith('https://example.test/slack', expect.stringContaining('change 20.0%'));
    expect(mocks.collect).toHaveBeenCalledWith({
      end: new Date('2026-10-26T12:00:00Z'),
      duration: 12 * 3_600_000,
      mode: 'intraday',
    });
  });

  it('stays quiet for <5% even with a large absolute delta', async () => {
    mocks.collect.mockResolvedValue({
      metrics: [{ name: 'requests:user', values: [1040, 1000], contributors: [] }],
      subscribers: 1,
      subscriberContributors: [],
    });
    expect(await handler({ time: '2026-10-26T00:05:00Z' })).toMatchObject({ anomalies: 0, delivered: 0 });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('fails loudly for a missing webhook and skips preview stages', async () => {
    mocks.settings.mockResolvedValue({ webhook: '' });
    await expect(handler({})).rejects.toThrow('Configure SlackUserActivityWebhookUrl');
    expect(mocks.collect).not.toHaveBeenCalled();
    mocks.resource.App.stage = 'pr123';
    expect(await handler({})).toEqual({ status: 'skipped' });
  });

  it('fails the invocation on rejected Slack delivery', async () => {
    mocks.post.mockResolvedValue(false);
    await expect(handler({})).rejects.toThrow('Slack rejected');
  });
});
