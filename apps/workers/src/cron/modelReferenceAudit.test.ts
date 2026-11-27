import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, report, warn, pendingSuggestions } = vi.hoisted(() => ({
  send: vi.fn(),
  report: vi.fn(),
  warn: vi.fn(),
  pendingSuggestions: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ modelDiscoveryStateRepository: { pendingSuggestions } }));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = send;
  },
  PutMetricDataCommand: class {
    constructor(public readonly input: unknown) {}
  },
  StandardUnit: { Count: 'Count' },
}));
vi.mock('@bike4mind/server-utils/modelDiscovery/modelReferenceReport', () => ({ modelReferenceReport: report }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    warn = warn;
    error = vi.fn();
  },
}));
const { auditModelReferences, actionableModelReferences } = await import('./modelReferenceAudit');

beforeEach(() => {
  vi.resetAllMocks();
  report.mockResolvedValue([]);
  pendingSuggestions.mockResolvedValue([]);
});

describe('scheduled model reference audit', () => {
  it('ignores dead chain keys and deliberately unconfigured optional fallback providers', () => {
    expect(
      actionableModelReferences([
        { surface: 'fallback-chain-key', key: 'old', referencedId: 'old', problem: 'retired' },
        { surface: 'fallback-chain', key: 'primary', referencedId: 'optional', problem: 'not-invocable' },
        { surface: 'fallback-chain', key: 'primary', referencedId: 'retired', problem: 'retired' },
        { surface: 'configured-model', key: 'primaryModel', referencedId: 'required', problem: 'not-invocable' },
        {
          surface: 'configured-model',
          key: 'orchestrationDefaults.intentClassifier.fallbackModels.0',
          referencedId: 'optional',
          problem: 'not-invocable',
        },
      ])
    ).toEqual([
      { surface: 'fallback-chain', key: 'primary', referencedId: 'retired', problem: 'retired' },
      { surface: 'configured-model', key: 'primaryModel', referencedId: 'required', problem: 'not-invocable' },
    ]);
  });

  it('publishes the unavailable count and logs each model and reason', async () => {
    const reference = {
      surface: 'configured-model',
      key: 'intent.primaryModel',
      referencedId: 'hidden',
      problem: 'deprecated',
    };
    report.mockResolvedValue([reference]);
    await auditModelReferences('dev');
    expect(warn).toHaveBeenCalledWith(expect.any(String), reference);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Namespace: 'Lumina5/ModelDiscovery',
      MetricData: expect.arrayContaining([
        {
          MetricName: 'UnavailableModelReferences',
          Value: 1,
          Unit: 'Count',
          Dimensions: [
            { Name: 'Stage', Value: 'dev' },
            { Name: 'Host', Value: 'hosted' },
          ],
        },
      ]),
    });
  });

  it('publishes zero when every reported reference is an exempt optional fallback', async () => {
    report.mockResolvedValue([
      {
        surface: 'configured-model',
        key: 'orchestrationDefaults.fallbackModels.1',
        referencedId: 'keyless',
        problem: 'not-invocable',
      },
    ]);
    await auditModelReferences('dev');
    expect(warn).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: 'UnavailableModelReferences', Value: 0 })
    );
  });

  it('emits an explicit healthy zero and fails on read or metric publication errors', async () => {
    await auditModelReferences('dev');
    expect(send.mock.calls[0][0].input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: 'UnavailableModelReferences', Value: 0 })
    );
    report.mockRejectedValue(new Error('catalog unavailable'));
    await expect(auditModelReferences('dev')).rejects.toThrow('catalog unavailable');
    expect(send).toHaveBeenCalledTimes(1);
    report.mockResolvedValue([]);
    send.mockRejectedValue(new Error('cloudwatch unavailable'));
    await expect(auditModelReferences('dev')).rejects.toThrow('cloudwatch unavailable');
  });

  it('counts the unresolved operator queue so settled signals do not keep the alarm raised', async () => {
    pendingSuggestions.mockResolvedValue([{ modelId: 'pending' }]);
    await auditModelReferences('dev');
    expect(send.mock.calls[0][0].input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: 'LifecycleSuggestions', Value: 1 })
    );
    pendingSuggestions.mockResolvedValue([]);
    await auditModelReferences('dev');
    expect(send.mock.calls[1][0].input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: 'LifecycleSuggestions', Value: 0 })
    );
    pendingSuggestions.mockRejectedValue(new Error('queue read failed'));
    await expect(auditModelReferences('dev')).rejects.toThrow('queue read failed');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
