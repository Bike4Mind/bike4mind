import { afterEach, describe, expect, it, vi } from 'vitest';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';

const mockResource = vi.hoisted(() => ({ App: { stage: 'test' } as { stage: string } | undefined }));
vi.mock('sst', () => ({
  get Resource() {
    return mockResource;
  },
}));

const mockEmitMetrics = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetrics: mockEmitMetrics }));

const mockCategorizeToolError = vi.hoisted(() => vi.fn().mockReturnValue('rate_limit'));
vi.mock('@bike4mind/services', () => ({ categorizeToolError: mockCategorizeToolError }));

const mockIsOperatorFault = vi.hoisted(() => vi.fn().mockReturnValue(true));
vi.mock('@bike4mind/services/llm', () => ({ isOperatorFault: mockIsOperatorFault }));

import { emitProcessingFailed } from './processingFailedMetric';

const QUESTS_CLOUDWATCH_NAMESPACE = 'Lumina5/Quests';

afterEach(() => {
  vi.clearAllMocks();
  mockResource.App = { stage: 'test' };
});

const datum = (dimensions: Record<string, string>) => ({
  name: 'ProcessingFailed',
  value: 1,
  unit: StandardUnit.Count,
  dimensions,
});

describe('emitProcessingFailed', () => {
  it('emits the Stage, ErrorClass and Surface series for /process', async () => {
    await emitProcessingFailed('/process', new Error('429 Too Many Requests'));

    expect(mockCategorizeToolError).toHaveBeenCalledWith('429 Too Many Requests');
    expect(mockEmitMetrics).toHaveBeenCalledWith(QUESTS_CLOUDWATCH_NAMESPACE, [
      datum({ Stage: 'test' }),
      datum({ Stage: 'test', ErrorClass: 'rate_limit' }),
      datum({ Stage: 'test', Surface: '/process' }),
    ]);
  });

  it.each(['cli-sse', 'cli-ws', 'embed'] as const)(
    'emits only the Stage+Surface series on %s, leaving the /process series untouched',
    async surface => {
      await emitProcessingFailed(surface, new Error('429 Too Many Requests'));

      expect(mockEmitMetrics).toHaveBeenCalledWith(QUESTS_CLOUDWATCH_NAMESPACE, [
        datum({ Stage: 'test', Surface: surface }),
      ]);
    }
  );

  it.each(['cli-sse', 'cli-ws', 'embed'] as const)('skips a non-fault on the %s surface', async surface => {
    mockIsOperatorFault.mockReturnValueOnce(false);
    await emitProcessingFailed(surface, new Error('out of credits'));
    expect(mockEmitMetrics).not.toHaveBeenCalled();
  });

  it('counts every failure on /process without consulting the fault predicate', async () => {
    mockIsOperatorFault.mockReturnValue(false);
    await emitProcessingFailed('/process', new Error('out of credits'));
    expect(mockIsOperatorFault).not.toHaveBeenCalled();
    expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
    mockIsOperatorFault.mockReturnValue(true);
  });

  it('classifies a non-Error throw by its string form', async () => {
    await emitProcessingFailed('/process', 'a raw string failure');
    expect(mockCategorizeToolError).toHaveBeenCalledWith('a raw string failure');
  });

  it('resolves without throwing when building the datums fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockResource.App = undefined;

    await expect(emitProcessingFailed('cli-sse', new Error('boom'))).resolves.toBeUndefined();
    expect(mockEmitMetrics).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
