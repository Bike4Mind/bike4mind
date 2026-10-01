import { describe, expect, it, vi } from 'vitest';
import { recordGeneratedImages } from './recordGeneratedImages';

describe('recordGeneratedImages', () => {
  const logger = { warn: vi.fn() };

  it('increments once by the number of images', async () => {
    const incrementImageCount = vi.fn().mockResolvedValue(undefined);
    await recordGeneratedImages({ incrementImageCount }, 'session-1', 3, logger);
    expect(incrementImageCount).toHaveBeenCalledTimes(1);
    expect(incrementImageCount).toHaveBeenCalledWith('session-1', 3);
  });

  it('does nothing without a session, a counter, or images', async () => {
    const incrementImageCount = vi.fn();
    await recordGeneratedImages({ incrementImageCount }, undefined, 2, logger);
    await recordGeneratedImages({ incrementImageCount }, 'session-1', 0, logger);
    await recordGeneratedImages(undefined, 'session-1', 2, logger);
    await recordGeneratedImages({}, 'session-1', 2, logger);
    expect(incrementImageCount).not.toHaveBeenCalled();
  });

  it('swallows a failed write so the generation still succeeds', async () => {
    const incrementImageCount = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(recordGeneratedImages({ incrementImageCount }, 'session-1', 1, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
