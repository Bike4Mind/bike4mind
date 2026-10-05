import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, insufficientCreditsError } from '@bike4mind/common';
import { createVideoProviderRegistry, TestVideoProvider } from '@bike4mind/utils/videoProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { createVideoJob } from './createVideoJob';
import type { VideoJobDeps } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

const fakeHold = (params: { userId: string; requiredCredits: number }): CreditHold => ({
  ownerId: params.userId,
  ownerType: CreditHolderType.User,
  userId: params.userId,
  organizationId: null,
  reservedCredits: params.requiredCredits,
  balanceAfterHold: 1000,
});

const validRequest = {
  model: 'test-video',
  mode: 'text_to_video',
  prompt: 'a cat',
  durationSeconds: 4,
  aspectRatio: '16:9',
  resolution: '720p',
};

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const makeDeps = (overrides: Partial<VideoJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: VideoJobDeps = {
    repository,
    providers: createVideoProviderRegistry([new TestVideoProvider()]),
    getSettings: async () => ({ enforceCredits: true, videoGeneration: undefined }),
    resolveApiKey: async () => 'key',
    loadInputImage: async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' }),
    saveToFiles: vi.fn(),
    saveToGeneratedBucket: vi.fn(),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => new Date('2026-10-06T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'createVideoJob' } }),
    ...overrides,
  };
  return { deps, repository };
};

const user = { id: 'u1', organizationId: null };

describe('createVideoJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  it('holds credits, creates a pending job and enqueues it immediately', async () => {
    const { deps } = makeDeps();
    const result = await createVideoJob({ user, request: validRequest, source: 'studio' }, deps);
    expect(result).toMatchObject({
      ok: true,
      created: true,
      job: { state: 'pending', creditHold: { reservedCredits: expect.any(Number) } },
    });
    expect(deps.enqueue).toHaveBeenCalledWith(expect.any(String), 0);
  });

  it('invalid request holds no credits', async () => {
    const { deps } = makeDeps();
    const result = await createVideoJob(
      { user, request: { ...validRequest, durationSeconds: 12 }, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: false, status: 422, code: 'unsupported_duration' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('rejects malformed input with invalid_request', async () => {
    const result = await createVideoJob({ user, request: { model: 'nope' }, source: 'api' }, makeDeps().deps);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
  });

  it('rejects a disabled model', async () => {
    const { deps } = makeDeps({
      getSettings: async () => ({ enforceCredits: true, videoGeneration: { enabledModels: { 'test-video': false } } }),
    });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 403,
      code: 'model_disabled',
    });
  });

  it('rejects a model whose provider is not registered', async () => {
    const { deps } = makeDeps({ providers: createVideoProviderRegistry([]) });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 422,
      code: 'model_unavailable',
    });
  });

  it("rejects image_to_video when the input image is not the user's", async () => {
    const { deps } = makeDeps({ loadInputImage: async () => null });
    const result = await createVideoJob(
      { user, request: { ...validRequest, mode: 'image_to_video', inputImageFileId: 'f9' }, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: false, status: 404, code: 'input_image_not_found' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('maps insufficient credits to 402', async () => {
    vi.mocked(holdCredits).mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, makeDeps().deps)).toMatchObject({
      ok: false,
      status: 402,
      code: 'insufficient_credits',
      message: 'You do not have enough credits',
    });
  });

  it('rethrows a hold failure that is not insufficient credits', async () => {
    vi.mocked(holdCredits).mockRejectedValueOnce(new Error('db down'));
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, makeDeps().deps)).rejects.toThrow(
      'db down'
    );
  });

  it('skips the hold when credits are not enforced', async () => {
    const { deps } = makeDeps({ getSettings: async () => ({ enforceCredits: false, videoGeneration: undefined }) });
    const result = await createVideoJob({ user, request: validRequest, source: 'api' }, deps);
    expect(result).toMatchObject({ ok: true, job: { creditHold: null } });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('bills an organization member against the organization', async () => {
    const { deps } = makeDeps();
    const result = await createVideoJob(
      { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: true, job: { ownerType: CreditHolderType.Organization, ownerId: 'org1' } });
    expect(holdCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', organizationId: 'org1', featureLabel: 'video generation' }),
      deps.credits
    );
  });

  it('returns the existing job for a repeated idempotency key with the same request', async () => {
    const { deps } = makeDeps();
    const first = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
    expect(second.job.id).toBe(first.job.id);
    expect(holdCredits).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused idempotency key with a different request', async () => {
    const { deps } = makeDeps();
    await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createVideoJob(
      { user, request: { ...validRequest, prompt: 'a dog' }, source: 'api', idempotencyKey: 'k1' },
      deps
    );
    expect(second).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
  });

  it('answers a lost idempotency race as a replay of the winner and releases its own hold', async () => {
    const { deps, repository } = makeDeps();
    const winner = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    // The pre-check misses (the winner had not committed yet), then the unique index rejects the insert.
    vi.spyOn(repository, 'findByIdempotencyKey').mockResolvedValueOnce(null);
    vi.spyOn(repository, 'createJob').mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
    const loser = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    if (!winner.ok) throw new Error('expected the winner to succeed');
    expect(loser).toMatchObject({ ok: true, created: false, job: { id: winner.job.id } });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  describe('an ambiguous create failure', () => {
    const keyed = { user, request: validRequest, source: 'api' as const, idempotencyKey: 'k1' };

    it('keeps the hold when the insert landed before the error: onTerminal owns it', async () => {
      const { deps, repository } = makeDeps();
      const realCreate = repository.createJob.bind(repository);
      vi.spyOn(repository, 'createJob').mockImplementationOnce(async jobInput => {
        await realCreate(jobInput);
        throw new Error('ack lost');
      });
      await expect(createVideoJob(keyed, deps)).rejects.toThrow('ack lost');
      expect(repository.jobs.size).toBe(1);
      expect(releaseCreditHold).not.toHaveBeenCalled();
    });

    it('releases the hold once when the job is confirmed absent', async () => {
      const { deps, repository } = makeDeps();
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      await expect(createVideoJob(keyed, deps)).rejects.toThrow('write failed');
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });

    it('keeps the hold and alarms when the lookup itself fails', async () => {
      const { deps, repository } = makeDeps();
      const error = vi.spyOn(deps.logger, 'error');
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      vi.spyOn(repository, 'findByIdempotencyKey')
        .mockResolvedValueOnce(null) // the pre-insert replay check
        .mockRejectedValueOnce(new Error('read failed'));
      await expect(createVideoJob(keyed, deps)).rejects.toThrow('write failed');
      expect(releaseCreditHold).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'video_job_create_ambiguous',
        expect.objectContaining({ idempotencyKey: 'k1', ownerId: 'u1', reservedCredits: expect.any(Number) })
      );
    });

    it('keeps the hold and alarms without an idempotency key to look the job up by', async () => {
      const { deps, repository } = makeDeps();
      const error = vi.spyOn(deps.logger, 'error');
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      await expect(createVideoJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow(
        'write failed'
      );
      expect(releaseCreditHold).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith('video_job_create_ambiguous', expect.objectContaining({ ownerId: 'u1' }));
    });

    it('rethrows the original error when the release itself fails', async () => {
      const { deps, repository } = makeDeps();
      const error = vi.spyOn(deps.logger, 'error');
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      vi.mocked(releaseCreditHold).mockRejectedValueOnce(new Error('refund failed'));
      await expect(createVideoJob(keyed, deps)).rejects.toThrow('write failed');
      expect(error).toHaveBeenCalledWith('video_job_create_cleanup_failed', expect.objectContaining({ ownerId: 'u1' }));
    });
  });

  it('rethrows the enqueue error when failing the unqueued job also fails', async () => {
    const { deps, repository } = makeDeps({
      enqueue: vi.fn(async () => {
        throw new Error('SQS down');
      }),
    });
    const error = vi.spyOn(deps.logger, 'error');
    vi.spyOn(repository, 'commit').mockRejectedValueOnce(new Error('mongo down'));
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
    expect(error).toHaveBeenCalledWith(
      'video_job_create_cleanup_failed',
      expect.objectContaining({ jobId: expect.any(String), ownerId: 'u1' })
    );
  });

  it('releases the hold and fails the job when enqueue throws', async () => {
    const { deps, repository } = makeDeps({
      enqueue: vi.fn(async () => {
        throw new Error('SQS down');
      }),
    });
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
    const [job] = [...repository.jobs.values()];
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('enqueue_failed');
    expect(job.nextPollAt).toBeNull();
    expect(job.settledCredits).toBe(0);
    expect(job.terminalHandledAt).toBeTruthy();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });
});
