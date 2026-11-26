import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MetricDatum, PutMetricDataCommandInput } from '@aws-sdk/client-cloudwatch';
import type { Logger } from '@bike4mind/observability';

const send = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn(function (this: { send: typeof send }) {
    this.send = send;
  }),
  PutMetricDataCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  StandardUnit: { Count: 'Count' },
}));

import {
  recordProviderCredentialUse,
  PROVIDER_CREDENTIAL_NAMESPACE,
  PROVIDER_CREDENTIAL_USE_METRIC,
  PROVIDER_CREDENTIAL_FALLBACK_METRIC,
} from './providerCredentialMetrics';

function sentInput(): PutMetricDataCommandInput {
  return (send.mock.calls[0][0] as { input: PutMetricDataCommandInput }).input;
}

function dimensionsOf(datum: MetricDatum): Record<string, string | undefined> {
  return Object.fromEntries((datum.Dimensions ?? []).map(d => [d.Name, d.Value]));
}

describe('recordProviderCredentialUse', () => {
  const ENV_NAMES = ['SEED_STAGE_NAME', 'PROVIDER_CREDENTIAL_METRICS'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    process.env.SEED_STAGE_NAME = 'production';
    process.env.PROVIDER_CREDENTIAL_METRICS = 'true';
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  // infra/alarms.ts cannot import these constants, so the literals are pinned here.
  it('pins the names the infra alarm references', () => {
    expect(PROVIDER_CREDENTIAL_NAMESPACE).toBe('Lumina5/ProviderCredential');
    expect(PROVIDER_CREDENTIAL_USE_METRIC).toBe('ProviderCredentialUse');
    expect(PROVIDER_CREDENTIAL_FALLBACK_METRIC).toBe('ProviderCredentialFallback');
  });

  it.each(['static', 'federated'] as const)(
    'emits one %s usage datapoint by stage, provider and credential',
    async credential => {
      await recordProviderCredentialUse('anthropic', credential);

      const input = sentInput();
      expect(input.Namespace).toBe(PROVIDER_CREDENTIAL_NAMESPACE);
      expect(input.MetricData).toHaveLength(1);
      const [usage] = input.MetricData ?? [];
      expect(usage.MetricName).toBe(PROVIDER_CREDENTIAL_USE_METRIC);
      expect(usage.Value).toBe(1);
      expect(dimensionsOf(usage)).toEqual({ Stage: 'production', Provider: 'anthropic', Credential: credential });
    }
  );

  it('adds a Stage-only fallback datapoint for the alarm on static_fallback', async () => {
    await recordProviderCredentialUse('openai', 'static_fallback');

    const metricData = sentInput().MetricData ?? [];
    expect(metricData).toHaveLength(2);
    const [usage, fallback] = metricData;
    expect(usage.MetricName).toBe(PROVIDER_CREDENTIAL_USE_METRIC);
    expect(dimensionsOf(usage)).toEqual({ Stage: 'production', Provider: 'openai', Credential: 'static_fallback' });
    expect(fallback).toMatchObject({ MetricName: PROVIDER_CREDENTIAL_FALLBACK_METRIC, Value: 1, Unit: 'Count' });
    expect(dimensionsOf(fallback)).toEqual({ Stage: 'production' });
  });

  it.each(ENV_NAMES)('does nothing when %s is unset', async name => {
    delete process.env[name];

    await recordProviderCredentialUse('openai', 'federated');

    expect(send).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when CloudWatch rejects the datapoint', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    const warn = vi.fn();

    await expect(
      recordProviderCredentialUse('anthropic', 'federated', { warn } as unknown as Logger)
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[provider-credential] Failed to emit ProviderCredentialUse metric',
      expect.objectContaining({ provider: 'anthropic', credential: 'federated', error: 'throttled' })
    );
  });
});
