import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { storeGeneratedOutput, type StoreOutputDeps, type StoreOutputParams } from './storeOutput';

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const setup = (overrides: Partial<StoreOutputDeps> = {}) => {
  const deps: StoreOutputDeps = {
    saveToFiles: vi.fn(async () => ({ saved: true as const, fileId: 'f1', s3Key: 'files/k', fileName: 'out.png' })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    logger: logger(),
    ...overrides,
  };
  return deps;
};

const params = (overrides: Partial<StoreOutputParams> = {}): Omit<StoreOutputParams, 'moderate'> => ({
  job: { id: 'j1', ownerId: 'o1', requestedBy: 'u1' },
  noun: 'thing',
  bytes: Buffer.from('bytes'),
  contentType: 'image/png',
  generation: { generator: 'image', provider: 'p', modelId: 'm', jobId: 'j1', prompt: 'a cat' },
  bucketFolder: 'generated-things',
  extension: 'png',
  onFilesError: 'fallback',
  signal: new AbortController().signal,
  ...overrides,
});

describe('storeGeneratedOutput', () => {
  it('saves to Files with lineage, quest and session', async () => {
    const deps = setup();
    const derivedFrom = [{ fileId: 'in1', role: 'reference' as const }];
    const result = await storeGeneratedOutput(params({ derivedFrom, questId: 'q1', sessionId: 's1' }), deps);

    expect(result).toEqual({ stored: true, location: { location: 'files', s3Key: 'files/k', fileId: 'f1' } });
    expect(deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', derivedFrom, questId: 'q1', sessionId: 's1' })
    );
    expect(deps.saveToGeneratedBucket).not.toHaveBeenCalled();
  });

  it('omits an empty lineage and absent ids', async () => {
    const deps = setup();
    await storeGeneratedOutput(params({ derivedFrom: [] }), deps);
    const call = vi.mocked(deps.saveToFiles).mock.calls[0][0];
    expect(call).not.toHaveProperty('derivedFrom');
    expect(call).not.toHaveProperty('questId');
    expect(call).not.toHaveProperty('sessionId');
  });

  it('falls back to the generated bucket when Files refuses the output', async () => {
    const deps = setup({ saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })) });
    const result = await storeGeneratedOutput(params(), deps);

    expect(result).toEqual({ stored: true, location: { location: 'generated', s3Key: 'generated-things/o1/j1.png' } });
    expect(deps.logger.warn).toHaveBeenCalledWith('thing saved outside Files', { jobId: 'j1', reason: 'storage_limit' });
  });

  it('falls back on a throwing Files save under the fallback policy', async () => {
    const deps = setup({ saveToFiles: vi.fn(async () => Promise.reject(new Error('down'))) });
    const result = await storeGeneratedOutput(params(), deps);
    expect(result).toMatchObject({ stored: true, location: { location: 'generated' } });
  });

  it('rethrows a throwing Files save under the rethrow policy, without touching the bucket', async () => {
    const error = new Error('down');
    const deps = setup({ saveToFiles: vi.fn(async () => Promise.reject(error)) });
    await expect(storeGeneratedOutput(params({ onFilesError: 'rethrow' }), deps)).rejects.toBe(error);
    expect(deps.saveToGeneratedBucket).not.toHaveBeenCalled();
  });

  it('gives the fallback a fresh signal when the step signal already fired', async () => {
    const controller = new AbortController();
    const deps = setup({
      saveToFiles: vi.fn(async () => {
        controller.abort();
        return { saved: false as const, reason: 'storage_limit' as const };
      }),
    });
    await storeGeneratedOutput(params({ signal: controller.signal }), deps);
    const { signal } = vi.mocked(deps.saveToGeneratedBucket).mock.calls[0][0];
    expect(signal).not.toBe(controller.signal);
    expect(signal.aborted).toBe(false);
  });

  it('logs and rethrows when the bucket fallback fails too', async () => {
    const error = new Error('s3 down');
    const deps = setup({
      saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })),
      saveToGeneratedBucket: vi.fn(async () => Promise.reject(error)),
    });
    await expect(storeGeneratedOutput(params(), deps)).rejects.toBe(error);
    expect(deps.logger.error).toHaveBeenCalledWith('thing_job_output_unsaved', { jobId: 'j1', bytes: 5, error });
  });

  describe('moderation hook', () => {
    it('keeps nothing when the scan blocks the output', async () => {
      const deps = setup();
      const result = await storeGeneratedOutput(
        { ...params(), moderate: async () => ({ blocked: true, reason: 'nope' }) },
        deps
      );
      expect(result).toEqual({ stored: false, reason: 'nope' });
      expect(deps.saveToFiles).not.toHaveBeenCalled();
      expect(deps.saveToGeneratedBucket).not.toHaveBeenCalled();
    });

    it('fails closed when the scan cannot run', async () => {
      const deps = setup();
      const moderate = vi.fn(async () => Promise.reject(new Error('scanner down')));
      await expect(storeGeneratedOutput({ ...params(), moderate }, deps)).rejects.toThrow('scanner down');
      expect(deps.saveToFiles).not.toHaveBeenCalled();
    });

    it('stores an output the scan passes', async () => {
      const deps = setup();
      const result = await storeGeneratedOutput({ ...params(), moderate: async () => ({ blocked: false }) }, deps);
      expect(result).toMatchObject({ stored: true, location: { location: 'files' } });
    });
  });
});
