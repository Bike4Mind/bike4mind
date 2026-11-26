import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  recordProviderCredentialUse,
  PROVIDER_CREDENTIAL_NAMESPACE,
  PROVIDER_CREDENTIAL_USE_METRIC,
  PROVIDER_CREDENTIAL_FALLBACK_METRIC,
} from './providerCredentialMetrics';

describe('recordProviderCredentialUse', () => {
  const ENV_NAMES = ['SEED_STAGE_NAME', 'PROVIDER_CREDENTIAL_METRICS'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let info: ReturnType<typeof vi.spyOn>;

  function emitted(): Record<string, unknown> & { _aws: { CloudWatchMetrics: unknown[] } } {
    expect(info).toHaveBeenCalledTimes(1);
    return JSON.parse(info.mock.calls[0][0] as string);
  }

  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
    process.env.SEED_STAGE_NAME = 'production';
    process.env.PROVIDER_CREDENTIAL_METRICS = 'true';
  });

  afterEach(() => {
    info.mockRestore();
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
    'emits one %s usage metric by stage, provider and credential',
    credential => {
      recordProviderCredentialUse('anthropic', credential);

      const record = emitted();
      expect(record).toMatchObject({
        Stage: 'production',
        Provider: 'anthropic',
        Credential: credential,
        ProviderCredentialUse: 1,
      });
      expect(record).not.toHaveProperty('ProviderCredentialFallback');
      expect(record._aws.CloudWatchMetrics).toEqual([
        {
          Namespace: PROVIDER_CREDENTIAL_NAMESPACE,
          Dimensions: [['Stage', 'Provider', 'Credential']],
          Metrics: [{ Name: PROVIDER_CREDENTIAL_USE_METRIC, Unit: 'Count' }],
        },
      ]);
    }
  );

  it('adds a Stage-only fallback metric for the alarm on static_fallback', () => {
    recordProviderCredentialUse('openai', 'static_fallback');

    const record = emitted();
    expect(record).toMatchObject({
      Stage: 'production',
      Provider: 'openai',
      Credential: 'static_fallback',
      ProviderCredentialUse: 1,
      ProviderCredentialFallback: 1,
    });
    expect(record._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: PROVIDER_CREDENTIAL_NAMESPACE,
        Dimensions: [['Stage', 'Provider', 'Credential']],
        Metrics: [{ Name: PROVIDER_CREDENTIAL_USE_METRIC, Unit: 'Count' }],
      },
      {
        Namespace: PROVIDER_CREDENTIAL_NAMESPACE,
        Dimensions: [['Stage']],
        Metrics: [{ Name: PROVIDER_CREDENTIAL_FALLBACK_METRIC, Unit: 'Count' }],
      },
    ]);
  });

  it.each(ENV_NAMES)('does nothing when %s is unset', name => {
    delete process.env[name];

    recordProviderCredentialUse('openai', 'federated');

    expect(info).not.toHaveBeenCalled();
  });

  it('does not throw when writing to stdout fails', () => {
    info.mockImplementation(() => {
      throw new Error('stdout closed');
    });

    expect(() => recordProviderCredentialUse('anthropic', 'federated')).not.toThrow();
  });
});
