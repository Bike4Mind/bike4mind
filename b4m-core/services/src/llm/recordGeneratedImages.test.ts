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

  it('logs when a real session and count have no incrementImageCount adapter wired', async () => {
    const warn = vi.fn();
    await recordGeneratedImages({}, 'session-1', 2, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No incrementImageCount adapter wired'), {
      sessionId: 'session-1',
      count: 2,
    });
  });

  it('does not log for the benign no-session or zero-count early returns', async () => {
    const warn = vi.fn();
    await recordGeneratedImages({ incrementImageCount: vi.fn() }, undefined, 2, { warn });
    await recordGeneratedImages({ incrementImageCount: vi.fn() }, 'session-1', 0, { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
