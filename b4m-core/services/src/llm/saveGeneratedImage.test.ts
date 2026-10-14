import { describe, it, expect, vi } from 'vitest';
import { saveGeneratedImage, type SaveGeneratedAssetFn } from './saveGeneratedImage';

type Params = Parameters<SaveGeneratedAssetFn>[0];

const params = {
  userId: 'user1',
  bytes: Buffer.from('png'),
  contentType: 'image/png',
  generation: { generator: 'image', provider: 'bfl', modelId: 'm', prompt: 'a cat', jobId: 'j-0' },
} as unknown as Params;

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('saveGeneratedImage', () => {
  it('is a no-op when no save function is injected', async () => {
    const logger = makeLogger();
    await expect(saveGeneratedImage(undefined, params, logger)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('passes the params and logger through to the save function', async () => {
    const save = vi.fn<SaveGeneratedAssetFn>(async () => ({ saved: true }) as never);
    const logger = makeLogger();
    await saveGeneratedImage(save, params, logger);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(params, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a warning when the save reports saved: false', async () => {
    const save = vi.fn<SaveGeneratedAssetFn>(async () => ({ saved: false, reason: 'storage_limit' }) as never);
    const logger = makeLogger();
    await saveGeneratedImage(save, params, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { reason: 'storage_limit' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error and resolves when the save rejects', async () => {
    const failure = new Error('boom');
    const save = vi.fn<SaveGeneratedAssetFn>(async () => Promise.reject(failure));
    const logger = makeLogger();

    await expect(saveGeneratedImage(save, params, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { error: failure });
  });
});
