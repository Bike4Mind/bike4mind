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

import { emitProcessingFailed, QUESTS_CLOUDWATCH_NAMESPACE } from './processingFailedMetric';

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
  it.each(['/process', 'cli-sse', 'cli-ws', 'embed'] as const)(
    'emits the alarm rollup, the ErrorClass breakdown and the %s Surface breakdown',
    async surface => {
      await emitProcessingFailed(surface, new Error('429 Too Many Requests'));

      expect(mockCategorizeToolError).toHaveBeenCalledWith('429 Too Many Requests');
      expect(mockEmitMetrics).toHaveBeenCalledWith(QUESTS_CLOUDWATCH_NAMESPACE, [
        datum({ Stage: 'test' }),
        datum({ Stage: 'test', ErrorClass: 'rate_limit' }),
        datum({ Stage: 'test', Surface: surface }),
      ]);
    }
  );

  it('classifies a non-Error throw by its string form', async () => {
    await emitProcessingFailed('embed', 'a raw string failure');
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
