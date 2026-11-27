// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { completeSample, type SampleCompletion } from './templateExampleSampleUsage';

const modelInfo = {
  id: 'ops-model',
  backend: 'openai',
  name: 'Ops',
  pricing: { input: 1, output: 2 },
} as unknown as ModelInfo;

type Complete = SampleCompletion['llm']['complete'];

const setup = (complete: Complete, timeoutMs = 1000) => {
  const record = vi.fn(async () => null);
  const opts: SampleCompletion = {
    llm: { complete },
    modelInfo,
    ledger: { usageEvents: { record } },
    listingId: 'listing-1',
    timeoutMs,
    logger: new Logger({ metadata: {} }),
  };
  return { opts, record };
};

describe('completeSample', () => {
  it('records the call as platform-paid usage for the listing', async () => {
    const { opts, record } = setup(async (_model, _messages, _options, callback) => {
      await callback(['# Sample'], { inputTokens: 120, outputTokens: 80 });
    });

    await expect(completeSample(opts, 'system', 'user')).resolves.toBe('# Sample');

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({
      userId: 'platform',
      ownerId: 'platform',
      ownerType: 'Platform',
      feature: 'operations',
      source: 'system',
      provider: 'openai',
      model: 'ops-model',
      creditsCharged: 0,
      settledBasis: 'provider',
      providerInputTokens: 120,
      providerOutputTokens: 80,
      status: 'ok',
      platformPaid: { reason: 'template_example_run', listingId: 'listing-1' },
    });
  });

  it('records a call that ran past the timeout once the provider ends it', async () => {
    let finish: () => void = () => {};
    const { opts, record } = setup(
      (_model, _messages, _options, callback) =>
        new Promise<void>(resolve => {
          finish = () => void callback(['late'], { inputTokens: 50, outputTokens: 10 }).then(resolve);
        }),
      5
    );

    await expect(completeSample(opts, 'system', 'user')).rejects.toThrow('The sample file timed out');
    expect(record).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'timeout', providerInputTokens: 50 });
  });

  it('records the billed usage of a call that failed after the provider reported it', async () => {
    const { opts, record } = setup(async (_model, _messages, _options, callback) => {
      await callback([], { inputTokens: 30 });
      throw new Error('stream broke');
    });

    await expect(completeSample(opts, 'system', 'user')).rejects.toThrow('stream broke');

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'error', providerInputTokens: 30 });
  });

  it('writes no row when the provider reported no usage', async () => {
    const { opts, record } = setup(async () => {
      throw new Error('refused before sending');
    });

    await expect(completeSample(opts, 'system', 'user')).rejects.toThrow('refused before sending');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(record).not.toHaveBeenCalled();
  });
});
